/**
 * Server 的会话查询与标记：沿 parentID 上溯、读上限/保护名单、写旗舰与
 * 显式模型委派标记、列出子会话并挑选淘汰候选。
 *
 * 这里只读/写会话与指令条目，不处理工具钩子和配额槽位；入口文件负责事务
 * 边界与拒绝信号。
 */

import { isCriticSession } from "./critic"
import { isFlagshipSession } from "./flagship"
import {
  hasFlagshipMarker,
  normalizeFlagshipModel,
  sameFlagshipModel,
  withFlagshipMarker,
  withoutFlagshipMarker,
} from "./flagship-admission"
import { withModelDelegationMarker } from "./model-delegation"
import {
  DEFAULT_MAX_SUBAGENTS,
  KEPT_SUBAGENTS_KEY,
  MAX_SUBAGENTS_KEY,
  STALE_AFTER_MS,
  Child,
  asArray,
  collabEnabledFromEntries,
  errorText,
  isObject,
  log,
} from "./server-state"
import { formatModelRef } from "./server-models"

/**
 * 读某个 root 家族的总开关。读失败按启用处理并留日志，
 * 避免一次查询异常把整族协作行为关死。
 */
export async function readRootCollabEnabled(ctx: any, rootID: string): Promise<boolean> {
  try {
    const entries = asArray(await ctx.session.instructions.entry.list({ sessionID: rootID }))
    return collabEnabledFromEntries(entries)
  } catch (cause) {
    log({
      event: "collab-read-failed",
      decision: "allow",
      root: rootID,
      note: "开关读取失败，按启用处理",
      cause: errorText(cause),
    })
    return true
  }
}

/** 按调用者所属 root 判断开关；上溯失败同样 fail-open。 */
export async function collabEnabledForSession(ctx: any, sessionID: string | undefined): Promise<boolean> {
  if (!sessionID) return true
  try {
    return await readRootCollabEnabled(ctx, await findRoot(ctx, sessionID))
  } catch (cause) {
    log({
      event: "collab-read-failed",
      decision: "allow",
      sessionID,
      note: "root 上溯失败，按启用处理",
      cause: errorText(cause),
    })
    return true
  }
}

/** 读 agent 配置（模型继承用）；拿不到按缺省处理，不阻断主流程。 */
export async function readAgentInfo(ctx: any, agentID: unknown): Promise<any | undefined> {
  if (typeof agentID !== "string" || agentID.length === 0) return undefined
  try {
    if (typeof ctx?.agent?.get === "function") {
      const output = await ctx.agent.get({ agentID })
      const info = isObject(output) && isObject(output.data) ? output.data : output
      if (isObject(info)) return info
    }
    if (typeof ctx?.agent?.list === "function") {
      const output = await ctx.agent.list()
      const items = asArray(isObject(output) && Array.isArray((output as any).data) ? (output as any).data : output)
      return items.find((item) => item?.id === agentID || item?.name === agentID)
    }
  } catch (cause) {
    log({
      event: "agent-read-failed",
      decision: "allow",
      agent: agentID,
      note: "agent 配置读取失败，按缺省模型继承",
      cause: errorText(cause),
    })
  }
  return undefined
}

export async function readSessionModel(ctx: any, sessionID: string): Promise<unknown> {
  try {
    const info = await ctx.session.get({ sessionID })
    return isObject(info) ? info.model : undefined
  } catch {
    return undefined
  }
}

export async function readSessionMetadata(ctx: any, sessionID: string): Promise<Record<string, unknown> | undefined> {
  try {
    const info = await ctx.session.get({ sessionID })
    return isObject(info) && isObject(info.metadata) ? info.metadata : undefined
  } catch {
    return undefined
  }
}

export function eventData(event: any): Record<string, any> {
  return isObject(event?.data) ? event.data : {}
}

/** 把旗舰标记写到 child 自身；保留原有 metadata，不写 root。 */
export async function markFlagshipSession(
  ctx: any,
  input: { sessionID: string; parentID?: string; model: unknown; metadata?: Record<string, unknown> },
): Promise<boolean> {
  const existing = input.metadata ?? (await readSessionMetadata(ctx, input.sessionID))
  const next = withFlagshipMarker(existing, input.model, Date.now())
  if (!next) return false
  await ctx.session.update({ sessionID: input.sessionID, metadata: next })
  log({
    event: "flagship-marked",
    decision: "allow",
    sessionID: input.sessionID,
    parentID: input.parentID,
    model: formatModelRef(input.model),
  })
  return true
}

/** 把显式模型委派标记写到 child 自身；保留原有 metadata，不写 root。 */
export async function markModelDelegationSession(
  ctx: any,
  input: {
    sessionID: string
    parentID?: string
    model: unknown
    metadata?: Record<string, unknown>
    phase?: "created" | "completed"
  },
): Promise<boolean> {
  const existing = input.metadata ?? (await readSessionMetadata(ctx, input.sessionID))
  const next = withModelDelegationMarker(existing, input.model, Date.now())
  if (!next) return false
  await ctx.session.update({ sessionID: input.sessionID, metadata: next })
  log({
    event: "model-delegation-marked",
    decision: "allow",
    sessionID: input.sessionID,
    parentID: input.parentID,
    model: formatModelRef(input.model),
    phase: input.phase ?? "completed",
  })
  return true
}

async function clearFlagshipSession(ctx: any, input: { sessionID: string; parentID?: string; reason: string }) {
  const existing = await readSessionMetadata(ctx, input.sessionID)
  if (!hasFlagshipMarker(existing)) return false
  const next = withoutFlagshipMarker(existing)
  if (!next) return false
  await ctx.session.update({ sessionID: input.sessionID, metadata: next })
  log({
    event: "flagship-cleared",
    decision: "allow",
    sessionID: input.sessionID,
    parentID: input.parentID,
    reason: input.reason,
  })
  return true
}

/**
 * `session.model.selected`：只处理有 parent 的 child。child 切走模型导致已有
 * 旗舰标记失效时清掉标记；无标记一律不动——切到与 parent 相同的模型也不新增
 * 旗舰身份（身份只来自显式委派成功后的标记）。root 切模型不遍历、不清洗旧 child 标记。
 */
export async function handleSessionModelSelected(ctx: any, event: any): Promise<void> {
  const data = eventData(event)
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  if (!sessionID) return
  const info = await ctx.session.get({ sessionID })
  if (!isObject(info) || typeof info.parentID !== "string" || !info.parentID) return
  if (isCriticSession(info)) return
  const metadata = isObject(info.metadata) ? info.metadata : undefined
  if (!hasFlagshipMarker(metadata)) return
  const model = data.model ?? info.model
  // 标记只随 child 自身切走模型而失效；root 模型不参与判定。
  if (isFlagshipSession({ model, metadata })) return
  await clearFlagshipSession(ctx, { sessionID, parentID: info.parentID, reason: "model-switched" })
}

/** 沿 parentID 上溯到 family root（没有 parentID 即 root）。 */
export async function findRoot(ctx: any, sessionID: string): Promise<string> {
  let current = sessionID
  const seen = new Set<string>([sessionID])
  for (;;) {
    const info = await ctx.session.get({ sessionID: current })
    const parentID = isObject(info) ? info.parentID : undefined
    if (typeof parentID !== "string" || parentID.length === 0 || seen.has(parentID)) return current
    seen.add(parentID)
    current = parentID
  }
}

/**
 * 读上限：从 caller 向上找第一个带任意 `superagent.*` 指令条目的会话，
 * 取其 `superagent.max-subagents`；缺省 5，非法值回退 5。
 */
export async function readLimit(
  ctx: any,
  callerID: string,
  rootID: string,
): Promise<{ limit: number; source?: string; entries?: any[] }> {
  let current = callerID
  const seen = new Set<string>([callerID])
  for (;;) {
    const entries = asArray(await ctx.session.instructions.entry.list({ sessionID: current }))
    if (entries.some((entry) => typeof entry?.key === "string" && entry.key.startsWith("superagent."))) {
      const raw = entries.find((entry) => entry?.key === MAX_SUBAGENTS_KEY)?.value
      const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN
      return {
        limit: Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_SUBAGENTS,
        source: current,
        entries,
      }
    }
    if (current === rootID) break
    const info = await ctx.session.get({ sessionID: current })
    const parentID = isObject(info) ? info.parentID : undefined
    if (typeof parentID !== "string" || parentID.length === 0 || seen.has(parentID)) break
    seen.add(parentID)
    current = parentID
  }
  return { limit: DEFAULT_MAX_SUBAGENTS }
}

/**
 * 放行判定：存在数 + 在途数是否已经压过上限。
 * 在途数含本次调用自己占的那一个槽，所以 `exist + inflight <= limit` 放行，
 * 意味着放行后（本次调用转成一个子会话、槽位还回去）共存总数恰好不超过上限。
 */
export function isOverLimit(exist: number, inflight: number, limit: number): boolean {
  return exist + inflight > limit
}

/** 解析 `superagent.kept-subagents` 的值：逗号分隔的 sessionID 列表。 */
export function parseKeptSubagents(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((item) => String(item))
    : typeof value === "string"
      ? value.split(",")
      : []
  return raw.map((item) => item.trim()).filter((item) => item.length > 0)
}

/**
 * 读保护名单：root 链上的 `superagent.kept-subagents` 条目（逗号分隔的 sessionID 列表）。
 * 沿 caller → root 上溯，命中第一个带该条目的会话，整条链都没有即无保护。
 * 只读不写：条目不存在时零副作用。
 */
export async function readKeptSubagents(
  ctx: any,
  callerID: string,
  rootID: string,
): Promise<Set<string>> {
  const kept = new Set<string>()
  let current = callerID
  const seen = new Set<string>([callerID])
  for (;;) {
    const entries = asArray(await ctx.session.instructions.entry.list({ sessionID: current }))
    const entry = entries.find((item) => item?.key === KEPT_SUBAGENTS_KEY)
    if (entry) {
      for (const id of parseKeptSubagents(entry.value)) kept.add(id)
      return kept
    }
    if (current === rootID) break
    const info = await ctx.session.get({ sessionID: current })
    const parentID = isObject(info) ? info.parentID : undefined
    if (typeof parentID !== "string" || parentID.length === 0 || seen.has(parentID)) break
    seen.add(parentID)
    current = parentID
  }
  return kept
}

/**
 * 读保护名单的容错版本：读失败按「没有保护」处理（fail-open），并留日志。
 * 一次查询异常不该把模型硬约束整体关死。
 */
export async function readKeptSubagentsSafe(
  ctx: any,
  callerID: string,
  rootID: string,
  context: Record<string, unknown> = {},
): Promise<Set<string> | undefined> {
  try {
    return await readKeptSubagents(ctx, callerID, rootID)
  } catch (cause) {
    log({
      event: "kept-read-failed",
      decision: "allow",
      root: rootID,
      note: "保护名单读取失败，按无保护处理",
      cause: errorText(cause),
      ...context,
    })
    return undefined
  }
}

/**
 * 本次 steer 会不会改变目标会话的模型：
 *  - 显式 `input.model` 生效；
 *  - 切换 agent 时 `agent.model` 生效；
 *  - 其余情况保持原模型（同模型续跑、未指定模型）。
 * 现有模型读不出来时按「会变」处理：模型不可改是硬约束，宁可拒绝。
 */
export function detectSteerModelChange(input: {
  explicitModel?: unknown
  agentModel?: unknown
  switched: boolean
  existingModel?: unknown
}): { from?: string; to?: string } | undefined {
  const explicit = normalizeFlagshipModel(input.explicitModel)
  const agentModel = normalizeFlagshipModel(input.agentModel)
  const next = explicit ?? (input.switched ? agentModel : undefined)
  if (!next) return undefined
  const existing = normalizeFlagshipModel(input.existingModel)
  if (existing && sameFlagshipModel(existing, next)) return undefined
  return { from: existing ? formatModelRef(existing) : undefined, to: formatModelRef(next) }
}

/** 受保护子会话改模型的拒绝文案：先取消保护，再改模型。 */
export function keptModelDenyMessage(input: { sessionID: string; from?: string; to?: string }): string {
  const from = input.from ?? "未知"
  const to = input.to ?? "未知"
  return `受保护子会话 ${input.sessionID} 的模型不可修改：当前 ${from}，本次调用会切到 ${to}。请先取消该子会话的保护（superagent.kept-subagents）再改模型。`
}

/** 把一个 session 列表项标注成判定用的 Child。 */
export function toChild(item: any, now: number): Child {
  const time = isObject(item?.time) ? item.time : {}
  const busy = typeof time.busy === "number" ? time.busy : undefined
  const idle = typeof time.idle === "number" ? time.idle : undefined
  const outcome = item?.outcome ?? null
  // time.busy 是最近一次执行的开始，time.idle 是最近一次执行的结束；
  // 终态会把 idle 推到 busy 之后，所以 busy > idle（或没有 idle）即仍在运行。
  const running = busy !== undefined && (idle === undefined || busy > idle)
  const finished = outcome != null
  // 被 shutdown 打断的子会话：outcome 为空、开了工却没有 idle，既没结束也早就不在跑了，
  // 于是永远进不了淘汰候选、永久占着名额。开工时间超过阈值就按陈旧处理，允许兜底淘汰。
  const stale = !finished && busy !== undefined && idle === undefined && now - busy > STALE_AFTER_MS
  return {
    id: String(item?.id),
    title: typeof item?.title === "string" ? item.title : undefined,
    outcome,
    created: typeof time.created === "number" ? time.created : undefined,
    busy,
    idle,
    running,
    finished,
    stale,
    model: item?.model,
    metadata: isObject(item?.metadata) ? item.metadata : undefined,
  }
}

/** root 的非归档直接子会话，并标注是否仍在运行、是否已结束、是否僵死。 */
export async function listChildren(ctx: any, rootID: string, now: number): Promise<Child[]> {
  const items = asArray(await ctx.session.list({ parentID: rootID, archived: false })).filter(
    (item) => isObject(item) && item.time?.archived === undefined,
  )
  // critic 复核会话也挂在 root 下，但它不是子代理：不占名额、也不参与淘汰，
  // 否则一次复核期间可能顶掉一个正常子代理。
  return items.filter((item) => !isCriticSession(item)).map((item) => toChild(item, now))
}

/**
 * 淘汰候选：先正常已结束的（最旧优先），没有再兜底用僵尸（同样最旧优先）。
 * 正在 steer 的、以及被保护的子会话一律不动。
 */
export function pickVictim(
  children: Child[],
  steered: Set<string>,
  kept: Set<string>,
): { child: Child; reason: "finished" | "stale-evict" } | undefined {
  const eligible = children.filter((child) => !steered.has(child.id) && !kept.has(child.id))
  const byCreated = (a: Child, b: Child) => (a.created ?? 0) - (b.created ?? 0)
  // 僵尸按「开工时间」排：开了工却没等到收尾的，越早开工的越该先清。
  const byBusy = (a: Child, b: Child) => (a.busy ?? a.created ?? 0) - (b.busy ?? b.created ?? 0)
  const finished = eligible.filter((child) => child.finished && !child.running).sort(byCreated)
  if (finished.length > 0) return { child: finished[0], reason: "finished" }
  const stale = eligible.filter((child) => child.stale).sort(byBusy)
  if (stale.length > 0) return { child: stale[0], reason: "stale-evict" }
  return undefined
}

/**
 * 淘汰 remove 失败后的并发判定：重新列 children——victim 已不在刷新结果里，
 * 说明它已被并发请求移除（或删除实际已生效），调用方采纳新列表继续即可；
 * victim 仍在列表里就是真实失败；刷新自身失败也按真实失败处理。
 * 继续的前提是 victim 从列表里消失、列表只会变短，不会无限循环。
 */
export async function classifyEvictFailure(
  ctx: any,
  rootID: string,
  victimID: string,
  now: number,
): Promise<
  | { status: "concurrent"; children: Child[] }
  | { status: "real" }
  | { status: "refresh-failed"; cause: unknown }
> {
  let refreshed: Child[]
  try {
    refreshed = await listChildren(ctx, rootID, now)
  } catch (cause) {
    return { status: "refresh-failed", cause }
  }
  if (refreshed.some((child) => child.id === victimID)) return { status: "real" }
  return { status: "concurrent", children: refreshed }
}
