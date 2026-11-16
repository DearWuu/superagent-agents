/**
 * 子代理一收尾就按上限淘汰超额：不再等下一次派发才腾位。
 *
 * 依赖全部由调用方注入：列子会话、读上限、读保护名单、删除、并发判定、
 * steer 标记与在途计数都来自 server 侧，便于用假依赖直接驱动单测。
 * 宿主接线在 server.ts，收尾触发点在 subagent-status.ts 的 settleStatus。
 */

import { errorText, type Child } from "./server-state"

/** remove 失败后的判定结果：与 server-session.ts 的 classifyEvictFailure 同型。 */
export type EvictVerdict =
  | { status: "concurrent"; children: Child[] }
  | { status: "real" }
  | { status: "refresh-failed"; cause: unknown }

export type CompletionEvictDeps = {
  /** root 的非归档直接子会话（critic 会话已由调用方排除）。 */
  listChildren: (rootID: string, now: number) => Promise<Child[]>
  /** 当前 root 生效的子代理总上限。 */
  readLimit: (rootID: string) => Promise<number>
  /** 保护名单；读失败返回 undefined，此时本轮不删任何会话。 */
  readKept: (rootID: string) => Promise<Set<string> | undefined>
  remove: (sessionID: string) => Promise<void>
  /** 删除抛错后重新核对 victim 是否已被并发移除。 */
  classify: (rootID: string, victimID: string, now: number) => Promise<EvictVerdict>
  /** 正在被 steer 的子会话：淘汰时避开。 */
  isSteered: (sessionID: string) => boolean
  /** root 上仍在飞行（子会话尚未创建）的调用数。 */
  inflight?: (rootID: string) => number
  /** 协作总开关；明确 false 时不淘汰。 */
  enabled?: (rootID: string) => Promise<boolean>
  now?: () => number
  log: (event: Record<string, unknown>) => void
}

export type CompletionEvictor = {
  /** 收尾后腾位：同一 root 单飞，进行中再触发只补跑一轮。 */
  evictExcess: (rootID: string) => Promise<void>
}

/** 淘汰候选：已结束且没在跑，按创建时间升序；缺失时退回 busy，再缺省为 0。 */
function pickCandidate(children: Child[], kept: Set<string>, isSteered: (sessionID: string) => boolean) {
  const created = (child: Child) => child.created ?? child.busy ?? 0
  return children
    .filter((child) => child.finished && !child.running && !kept.has(child.id) && !isSteered(child.id))
    .sort((a, b) => created(a) - created(b))[0]
}

/**
 * 收尾淘汰器：一次收尾把 root 拉回上限以内。
 * 不使用僵尸兜底——僵尸子会话可能还有后台任务，收尾时刻不动它们。
 */
export function createCompletionEvictor(deps: CompletionEvictDeps): CompletionEvictor {
  const clock = deps.now ?? Date.now
  /** root → 进行中的一轮；新触发不并发进入，只置 rerun。 */
  const running = new Map<string, Promise<void>>()
  const rerun = new Set<string>()

  const evictRound = async (rootID: string) => {
    let evicted = 0
    for (;;) {
      const now = clock()
      const children = await deps.listChildren(rootID, now)
      const exist = children.length
      const inflight = deps.inflight?.(rootID) ?? 0
      const limit = await deps.readLimit(rootID)
      if (exist + inflight <= limit) return
      const kept = await deps.readKept(rootID)
      if (kept === undefined) {
        deps.log({ event: "evict-skip", trigger: "completion", root: rootID, reason: "kept-read-failed" })
        return
      }
      const victim = pickCandidate(children, kept, deps.isSteered)
      if (!victim) {
        deps.log({
          event: "evict-blocked",
          trigger: "completion",
          root: rootID,
          exist,
          inflight,
          count: exist + inflight,
          limit,
        })
        return
      }
      try {
        await deps.remove(victim.id)
      } catch (cause) {
        const verdict = await deps.classify(rootID, victim.id, clock())
        if (verdict.status === "concurrent") {
          // victim 已被并发请求删掉（或删除已生效）：刷新后的列表在下一轮重列时生效。
          deps.log({
            event: "evict-concurrent",
            trigger: "completion",
            root: rootID,
            victim: victim.id,
            cause: errorText(cause),
          })
          continue
        }
        deps.log({
          event: "evict-failed",
          decision: "error",
          trigger: "completion",
          root: rootID,
          victim: victim.id,
          cause: errorText(cause),
        })
        return
      }
      evicted += 1
      deps.log({
        event: "subagent-evict",
        decision: "allow",
        trigger: "completion",
        reason: "finished",
        root: rootID,
        victim: victim.id,
        exist,
        inflight,
        count: exist + inflight,
        limit,
        evicted,
      })
    }
  }

  const evictExcess = async (rootID: string): Promise<void> => {
    if (deps.enabled && (await deps.enabled(rootID)) === false) return
    const active = running.get(rootID)
    if (active) {
      rerun.add(rootID)
      return active
    }
    const run = (async () => {
      try {
        do {
          rerun.delete(rootID)
          await evictRound(rootID)
        } while (rerun.has(rootID))
      } catch (cause) {
        deps.log({
          event: "evict-error",
          decision: "error",
          trigger: "completion",
          root: rootID,
          cause: errorText(cause),
        })
      } finally {
        rerun.delete(rootID)
        running.delete(rootID)
      }
    })()
    running.set(rootID, run)
    return run
  }

  return { evictExcess }
}