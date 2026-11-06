/**
 * superagent-agents —— 服务端（server）入口。
 *
 * 职责：在 `subagent` 工具执行前，按「root 家族的非归档直接子会话数 + 飞行中调用数」
 * 做硬上限拦截。TUI 右栏（./tui）里的上限只是提示词层的软约束，这里是硬约束：
 * 超限时在工具执行前抛错，子会话不会被创建。
 *
 * 判定口径：
 *  - root：沿 parentID 逐级上溯到没有 parentID 的会话；
 *  - 存在数：root 的非归档直接子会话数；
 *  - 在途数：本 root 上还没跑完的 subagent 调用数（含本次调用自己占的那一个槽）。
 *    本次调用要占的槽就是它在途里的这一份，判定与淘汰都不再另加一份，
 *    所以放行条件是 `存在数 + 在途数 <= 上限`——放行后共存的子代理不会超过上限；
 *  - 上限：caller 沿父链遇到的第一个带 `superagent.*` 指令条目的会话上的
 *    `superagent.max-subagents`（缺省 5，非法值回退 5）；
 *  - steer（input.sessionID 非空）：续跑已有子会话，不占新槽，直接放行；
 *  - 超限：先淘汰「已结束、不在运行中、不是正在被 steer、也不在保护名单」里最旧的
 *    子会话；这类候选不够时，再兜底淘汰「开了工却没收尾、且已经僵死超过阈值」的
 *    僵尸子会话（记 stale-evict）；仍超限才拒绝。查询异常一律放行（fail-open）。
 *
 * 与 TUI 侧（./tui）的差异：
 *  - TUI 存着「保护 / 当前查看」这类编排状态，server 端读不到，
 *    所以保护名单通过 root 链上的 `superagent.kept-subagents` 指令条目传递：
 *    条目值是逗号分隔的 sessionID 列表，命中即跳过淘汰；条目不存在即无保护。
 *  - TUI 的上限读的是指令条目 + TUI 存储，server 端只能读指令条目。
 *
 * 限额备用模型：
 *  - 监听 `session.retry` 钩子；只有限额类错误（RateLimit / 429 / quota / 余额不足文本）
 *    计数，其他错误不计数。同一 session 连续失败达到 `superagent.fallback-threshold`
 *    （缺省 3）且已启用（`superagent.fallback-enabled`，缺省 true）时，经
 *    `ctx.session.switchModel` 切到 root 的 `superagent.fallback-model`、子会话的
 *    `superagent.subagent-fallback-model`；每个 session 只自动切一次，切完不回切。
 *    切换成功时把当次 retry 决策翻成「继续重试」，下一 attempt 就用新模型。
 *  - 成功信号（`session.step.ended` / `session.execution.succeeded`）清零计数。
 *  - 切换触发时把 root 的 `superagent.max-subagents` 降一档（5→4→3→2，下限 2），
 *    由常量 `QUOTA_TIER_DOWN` 控制；不自动恢复。
 *
 * 子代理复核（critic）：
 *  - 监听 `session.execution.succeeded`；只有 root 的 `superagent.critic-enabled`
 *    为真、且完成的是「root 家族里的非 root、非 critic 子会话」时才复核。
 *  - 复核在后台异步跑（`critic.ts`），失败只记日志，绝不影响会话主流程；
 *    结果写 critic 审计 JSONL，另外在 hook.log 留一条 `critic-finished`。
 *  - 同一完成事件可能被多个插件实例收到（reload 后旧订阅未必及时释放），
 *    用 `critic-claims/` 下的落盘声明保证只有一个实例真正复核。
 *
 * 超时状态探针：
 *  - 每 5 分钟扫一次会话列表，凡带 `superagent.*` 指令条目的 root 家族里，
 *    有 `time.busy`、没有 `time.idle` 与 outcome、且已运行满 30 分钟的子会话
 *    （与 TUI `LONG_RUNNING_THRESHOLD_MS` 同语义），发一条 steer 探针要一行状态。
 *  - 每个子会话只探一次（`probe-claims/` 落盘声明，跨插件实例同样只发一次）；
 *    critic 会话与 root 自身跳过。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { criticReview, isCriticSession, lastAssistantText } from "./critic"

const PLUGIN_ID = "superagent-agents-hardlimit"
const TOOL_NAME = "subagent"
const DEFAULT_MAX_SUBAGENTS = 5
const MAX_SUBAGENTS_KEY = "superagent.max-subagents"
/** root 链上记录「保护中的子会话」的指令条目，值是逗号分隔的 sessionID 列表。 */
const KEPT_SUBAGENTS_KEY = "superagent.kept-subagents"
/** 限额切换的目标模型：root 会话用前者，子会话用后者，值都是 `providerID/modelID`。 */
const FALLBACK_MODEL_KEY = "superagent.fallback-model"
const SUBAGENT_FALLBACK_MODEL_KEY = "superagent.subagent-fallback-model"
/** 连续限额失败多少次后切换，缺省 3。 */
const FALLBACK_THRESHOLD_KEY = "superagent.fallback-threshold"
/** `"true"` / `"false"`，缺省启用。 */
const FALLBACK_ENABLED_KEY = "superagent.fallback-enabled"
const DEFAULT_FALLBACK_THRESHOLD = 3
/** 子代理完成后的独立复核开关，缺省关闭。 */
export const CRITIC_ENABLED_KEY = "superagent.critic-enabled"
/** 超时探针的扫描间隔。 */
export const PROBE_INTERVAL_MS = 5 * 60 * 1000
/** 超时探针阈值：与 TUI `LONG_RUNNING_THRESHOLD_MS`（run-duration.ts）同语义。 */
export const PROBE_AFTER_MS = 30 * 60 * 1000
/** 超时探针正文：只要一行状态，避免把子代理从当前任务上带偏。 */
export const PROBE_TEXT =
  "[状态探针] 请只用一行回复当前状态：当前步骤 / 已完成部分 / 剩余与卡点；不要继续执行其他操作。"
/** 切换模型后第一次重试的等待：模型已经换了，旧 provider 的退避/retry-after 不再适用。 */
export const FALLBACK_RETRY_DELAY_MS = 1000
/** 限额切换时是否同步降档 max-subagents。 */
export const QUOTA_TIER_DOWN = true
/** 降档下限：降到 2 就不再降。 */
export const QUOTA_LIMIT_FLOOR = 2
/** 僵尸子会话的判定阈值：开了工又没等到收尾，超过这么久就按僵死处理。 */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000
/** 判定日志默认落盘位置。 */
export const DEFAULT_LOG_FILE = path.join(homedir(), ".local", "state", "opencode", "superagent", "hook.log")
/**
 * 判定日志实际落盘位置。默认在 opencode 的 state 目录下；
 * `SUPERAGENT_HOOK_LOG` 可改写到别处（测试用临时目录）。
 */
export function logFile(): string {
  const override = process.env.SUPERAGENT_HOOK_LOG
  return override ? path.resolve(override) : DEFAULT_LOG_FILE
}
/** superagent 的状态目录：`SUPERAGENT_STATE_DIR` 可改写（测试指向临时目录）。 */
export function stateRoot(): string {
  const override = process.env.SUPERAGENT_STATE_DIR
  return override
    ? path.resolve(override)
    : path.join(homedir(), ".local", "state", "opencode", "superagent")
}
/** 复核声明目录：同一完成事件只允许一个插件实例复核（进程内/进程间共用）。 */
function criticClaimDir(): string {
  return path.join(stateRoot(), "critic-claims")
}
/** 探针声明目录：同一子会话只允许一个插件实例发探针。 */
function probeClaimDir(): string {
  return path.join(stateRoot(), "probe-claims")
}

export type Child = {
  id: string
  title?: string
  outcome?: string | null
  created?: number
  busy?: number
  idle?: number
  /** 正在跑（有 busy，且没有更新的 idle）。 */
  running: boolean
  /** 跑到过终态（outcome 有值）。 */
  finished: boolean
  /** 僵尸：开了工没等到收尾，且已经僵死超过阈值。 */
  stale: boolean
}

/** 拒绝信号：只有它会被转成 ToolError，其他异常一律 fail-open。 */
class DenyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DenyError"
  }
}

let logDirReady = false

/**
 * JSONL 日志。background service 下 stdout 会被丢弃（console.log 不可靠），
 * 所以判定痕迹必须自己落盘。
 */
export function log(record: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), plugin: PLUGIN_ID, ...record })
  const file = logFile()
  try {
    if (!logDirReady) {
      mkdirSync(path.dirname(file), { recursive: true })
      logDirReady = true
    }
    appendFileSync(file, line + "\n")
  } catch {
    // 日志失败不能影响拦截本身。
  }
}

/**
 * 协作模式总开关的配置文件：`<XDG_CONFIG_HOME>/opencode/superagent.json`，
 * 内容形如 `{ "enabled": true }`。文件不存在、字段缺失或 JSON 损坏都按启用处理，
 * 保证「装了插件就全开」的默认体验，也让误删/写坏配置不会把功能永久关死。
 */
export const COLLAB_SWITCH_TTL_MS = 5000

export function collabSwitchPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return path.join(xdg ? xdg : path.join(homedir(), ".config"), "opencode", "superagent.json")
}

export type CollabSwitchState = { enabled: boolean; reason: "configured" | "default" | "corrupt" }

/** 开关的短缓存：钩子每次调用都会问，不能每次都同步读盘。 */
let collabSwitchCache: { checkedAt: number; state: CollabSwitchState } | undefined
/** 最近一次记过日志的开关状态，只在状态变化时落一条。 */
let collabLastLogged: { enabled: boolean; reason: string } | undefined

export function resetCollabSwitchCache() {
  collabSwitchCache = undefined
  collabLastLogged = undefined
}

export function readCollabSwitchState(now = Date.now()): CollabSwitchState {
  if (collabSwitchCache && now - collabSwitchCache.checkedAt < COLLAB_SWITCH_TTL_MS) {
    return collabSwitchCache.state
  }
  let state: CollabSwitchState
  try {
    const parsed: unknown = JSON.parse(readFileSync(collabSwitchPath(), "utf8"))
    const configured = isObject(parsed) && typeof parsed.enabled === "boolean"
    state = { enabled: configured ? (parsed as any).enabled : true, reason: configured ? "configured" : "default" }
  } catch (cause: any) {
    state = { enabled: true, reason: cause?.code === "ENOENT" ? "default" : "corrupt" }
  }
  collabSwitchCache = { checkedAt: now, state }
  return state
}

export function readCollabSwitch(now = Date.now()): boolean {
  return readCollabSwitchState(now).enabled
}

/**
 * 服务端所有协作行为的入口判据：停用时每条钩子直接返回，零副作用。
 * 状态翻转（含配置损坏）在 hook.log 留一条记录，便于排查「为什么没拦截」。
 */
export function collabEnabled(now = Date.now()): boolean {
  const state = readCollabSwitchState(now)
  const changed = !collabLastLogged || collabLastLogged.enabled !== state.enabled
  if (changed) {
    log({
      event: state.enabled ? "collab-switch-enabled" : "collab-switch-disabled",
      decision: state.enabled ? "allow" : "skip",
      enabled: state.enabled,
      path: collabSwitchPath(),
    })
  }
  if (state.reason === "corrupt" && collabLastLogged?.reason !== "corrupt") {
    log({
      event: "collab-switch-corrupt",
      decision: "allow",
      enabled: true,
      path: collabSwitchPath(),
      note: "配置读不懂，按启用处理",
    })
  }
  collabLastLogged = { enabled: state.enabled, reason: state.reason }
  return state.enabled
}

/** 一次性的跨实例声明：mkdir 原子，先创建成功者独占。 */
function claimOnce(dir: string, claimID: string | undefined): boolean {
  const safe = (claimID ?? "").replace(/[^A-Za-z0-9._-]/g, "")
  if (!safe) return true
  try {
    mkdirSync(dir, { recursive: true })
    mkdirSync(path.join(dir, safe))
    return true
  } catch {
    return false
  }
}

/** 复核声明：同一完成事件只允许一个插件实例复核（reload/多实例会重复订阅）。 */
export function claimCriticReview(claimID: string | undefined, dir: string = criticClaimDir()): boolean {
  return claimOnce(dir, claimID)
}

/** 探针声明：同一子会话只允许一个插件实例发探针。 */
export function claimProbe(sessionID: string | undefined, dir: string = probeClaimDir()): boolean {
  return claimOnce(dir, sessionID)
}

/** 清掉过期的声明，避免声明目录无限增长。 */
function pruneClaims(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs
  for (const dir of [criticClaimDir(), probeClaimDir()]) {
    try {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        try {
          if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true })
        } catch {}
      }
    } catch {}
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (isObject(value) && Array.isArray(value.data)) return value.data
  return []
}

function errorText(cause: unknown) {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** V2 事件把载荷放在 `data` 下；兼容测试/旧形态里的顶层 sessionID。 */
export function eventSessionID(event: any): string | undefined {
  const data = isObject(event?.data) ? event.data : {}
  if (typeof data.sessionID === "string" && data.sessionID.length > 0) return data.sessionID
  if (typeof event?.sessionID === "string" && event.sessionID.length > 0) return event.sessionID
  return undefined
}

/** `providerID/modelID[#variant]`，或已经是 `{providerID,id,variant?}` 的对象。 */
export type ModelRef = { providerID: string; id: string; variant?: string }

export function parseModelRef(value: unknown): ModelRef | undefined {
  if (isObject(value)) {
    if (typeof value.providerID !== "string" || value.providerID.length === 0) return undefined
    if (typeof value.id !== "string" || value.id.length === 0) return undefined
    return {
      providerID: value.providerID,
      id: value.id,
      ...(typeof value.variant === "string" && value.variant.length > 0 ? { variant: value.variant } : {}),
    }
  }
  if (typeof value !== "string") return undefined
  const text = value.trim()
  const slash = text.indexOf("/")
  if (slash <= 0 || slash === text.length - 1) return undefined
  const providerID = text.slice(0, slash)
  const rest = text.slice(slash + 1)
  const hash = rest.indexOf("#")
  const id = hash === -1 ? rest : rest.slice(0, hash)
  const variant = hash === -1 ? undefined : rest.slice(hash + 1)
  if (id.length === 0 || (variant !== undefined && variant.length === 0)) return undefined
  return { providerID, id, ...(variant ? { variant } : {}) }
}

export function formatModelRef(value: unknown): string | undefined {
  const ref = parseModelRef(value)
  return ref ? `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}` : undefined
}

/** core 把限额类失败归到这些 SessionError type（见 core/session/to-session-error.ts）。 */
const QUOTA_ERROR_TYPES = new Set([
  "provider.rate-limit",
  "provider.quota",
  "provider.free-limit",
  "provider.budget-limit",
  "provider.model-budget-limit",
  "provider.go-limit",
])
const QUOTA_TEXT =
  /rate[\s_-]?limit|too many requests|quota|insufficient[\s_-]?(quota|balance|credits?|funds)|balance is (?:too )?low|usage limit|out of credits?/i

/**
 * 限额类错误：RateLimit / 429 / quota / 余额不足文本。
 * 超时、网络、内容过滤等错误一律不算——它们换模型也救不回来。
 */
export function isQuotaFailure(error: unknown): boolean {
  if (isObject(error)) {
    if (typeof error.type === "string" && QUOTA_ERROR_TYPES.has(error.type)) return true
    // 直接拿到 AIError 的场合：reason 的 tag 或错误自身的 tag。
    if (isObject(error.reason) && error.reason._tag === "RateLimit") return true
    if (typeof error._tag === "string" && /rate-?limit/i.test(error._tag)) return true
    if (error.status === 429) return true
    const body = isObject(error.response) && typeof error.response.body === "string" ? error.response.body : undefined
    const text = [typeof error.message === "string" ? error.message : undefined, body].filter(Boolean).join(" ")
    if (text.length > 0) return QUOTA_TEXT.test(text)
    return false
  }
  return QUOTA_TEXT.test(errorText(error))
}

export type FallbackConfig = {
  enabled: boolean
  threshold: number
  rootModel?: ModelRef
  subModel?: ModelRef
}

/** 从指令条目读限额切换配置；缺省启用、阈值 3、未配置模型即不切换。 */
export function readFallbackConfig(entries: any[]): FallbackConfig {
  const entryValue = (key: string) => entries.find((entry) => entry?.key === key)?.value
  const enabledRaw = entryValue(FALLBACK_ENABLED_KEY)
  const enabled =
    typeof enabledRaw === "boolean"
      ? enabledRaw
      : typeof enabledRaw === "number"
        ? enabledRaw !== 0
        : typeof enabledRaw === "string"
          ? enabledRaw.trim().toLowerCase() !== "false" && enabledRaw.trim() !== "0"
          : true
  const thresholdRaw = entryValue(FALLBACK_THRESHOLD_KEY)
  const threshold = typeof thresholdRaw === "number" ? thresholdRaw : Number(thresholdRaw)
  return {
    enabled,
    threshold: Number.isInteger(threshold) && threshold >= 1 ? threshold : DEFAULT_FALLBACK_THRESHOLD,
    rootModel: parseModelRef(entryValue(FALLBACK_MODEL_KEY)),
    subModel: parseModelRef(entryValue(SUBAGENT_FALLBACK_MODEL_KEY)),
  }
}

/** 从指令条目读 max-subagents；缺省 5，非法值回退 5。 */
export function readMaxSubagents(entries: any[]): number {
  const raw = entries.find((entry) => entry?.key === MAX_SUBAGENTS_KEY)?.value
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_SUBAGENTS
}

/** 降一档；已到下限（≤2）返回 undefined。 */
export function downgradeLimit(current: number): number | undefined {
  if (!Number.isInteger(current) || current <= QUOTA_LIMIT_FLOOR) return undefined
  return Math.max(QUOTA_LIMIT_FLOOR, current - 1)
}

/** 指令条目的值是否表示「开」。字符串 `"true"` / `"1"` / `"on"` 都算。 */
export function isEnabledValue(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value !== "string") return false
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase())
}

/** 从指令条目读 `superagent.critic-enabled`；缺省关闭。 */
export function readCriticEnabled(entries: any[]): boolean {
  return isEnabledValue(entries.find((entry) => entry?.key === CRITIC_ENABLED_KEY)?.value)
}

/**
 * 复核触发判定：只复核「成功完成的、root 家族里的非 root、非 critic 子会话」，
 * 且 root 显式开启了 critic。另外避开同一子会话的并发复核。
 */
export function shouldCriticReview(input: {
  eventType: string
  childSessionID: string
  rootID: string
  child: { title?: string; metadata?: Record<string, unknown> } | undefined
  entries: any[]
  inFlight?: ReadonlySet<string>
}): boolean {
  if (input.eventType !== "session.execution.succeeded") return false
  if (!input.childSessionID || input.childSessionID === input.rootID) return false
  if (isCriticSession(input.child)) return false
  if (input.inFlight?.has(input.childSessionID)) return false
  return readCriticEnabled(input.entries)
}

export type ProbeCandidate = {
  id: string
  outcome?: string | null
  busy?: number
  idle?: number
  title?: string
  metadata?: Record<string, unknown>
}

/** 会话列表项 → 探针候选（只取判定要用的字段）。 */
export function toProbeCandidate(item: any): ProbeCandidate {
  const time = isObject(item?.time) ? item.time : {}
  return {
    id: String(item?.id ?? ""),
    outcome: item?.outcome ?? null,
    busy: typeof time.busy === "number" ? time.busy : undefined,
    idle: typeof time.idle === "number" ? time.idle : undefined,
    title: typeof item?.title === "string" ? item.title : undefined,
    metadata: isObject(item?.metadata) ? item.metadata : undefined,
  }
}

/**
 * 该子会话是否该探：开工了（有 busy）、没有 idle、没有 outcome，
 * 且开工距今已满阈值。每个会话只探一次，critic 会话跳过。
 */
export function shouldProbe(candidate: ProbeCandidate, now: number, probed: ReadonlySet<string>): boolean {
  if (!candidate.id || probed.has(candidate.id)) return false
  if (isCriticSession(candidate)) return false
  if (candidate.outcome != null) return false
  if (candidate.busy === undefined || candidate.idle !== undefined) return false
  return now - candidate.busy >= PROBE_AFTER_MS
}

export type ProbeScannerDeps = {
  /** 列出全部会话（root 与各层子会话都在内）。 */
  listSessions: () => Promise<ProbeCandidate[]>
  /** 沿 parentID 上溯到 family root。 */
  resolveRoot: (sessionID: string) => Promise<string | undefined>
  /** 该 root 是否带 superagent 配置（任意 `superagent.*` 指令条目）。 */
  rootIsConfigured: (rootID: string) => Promise<boolean>
  sendProbe: (sessionID: string, text: string) => Promise<void>
  /** 跨实例去重：返回 false 表示别的实例已经探过这个会话。 */
  claim?: (sessionID: string) => boolean
  /** 总开关：返回 false 时整轮扫描不做任何事（不列会话、不发探针）。 */
  enabled?: () => boolean
  log: (record: Record<string, unknown>) => void
  now?: () => number
}

/**
 * 超时探针扫描器。状态（已探过的 sessionID）在实例内，重启清零。
 * 失败一律只记日志：探不到或发不出都不影响会话本身。
 */
export function createProbeScanner(deps: ProbeScannerDeps) {
  const probed = new Set<string>()
  const now = deps.now ?? Date.now
  /** root → 是否带 superagent 配置；一个 root 只查一次。 */
  const configured = new Map<string, boolean>()
  return {
    probed,
    async scan(): Promise<number> {
      // 总开关关闭：不列会话、不查 root、不发探针。
      if (deps.enabled && !deps.enabled()) return 0
      let candidates: ProbeCandidate[]
      try {
        candidates = await deps.listSessions()
      } catch (cause) {
        deps.log({ event: "probe-scan-failed", decision: "error", cause: errorText(cause) })
        return 0
      }
      let sent = 0
      for (const candidate of candidates) {
        if (!shouldProbe(candidate, now(), probed)) continue
        let rootID: string | undefined
        try {
          rootID = await deps.resolveRoot(candidate.id)
        } catch (cause) {
          deps.log({ event: "probe-root-failed", decision: "error", sessionID: candidate.id, cause: errorText(cause) })
          continue
        }
        // root 自己不是子代理。
        if (!rootID || rootID === candidate.id) continue
        let managed = configured.get(rootID)
        if (managed === undefined) {
          try {
            managed = await deps.rootIsConfigured(rootID)
          } catch (cause) {
            deps.log({ event: "probe-config-failed", decision: "error", root: rootID, cause: errorText(cause) })
            continue
          }
          configured.set(rootID, managed)
        }
        if (!managed) continue
        // 跨实例声明：同一会话只会被一个插件实例发探针。
        if (deps.claim && !deps.claim(candidate.id)) continue
        // 先登记再发：发送失败也不在 5 分钟后重复轰炸同一个会话。
        probed.add(candidate.id)
        try {
          await deps.sendProbe(candidate.id, PROBE_TEXT)
          sent++
          deps.log({ event: "probe-sent", decision: "allow", root: rootID, sessionID: candidate.id })
        } catch (cause) {
          deps.log({
            event: "probe-failed",
            decision: "error",
            root: rootID,
            sessionID: candidate.id,
            cause: errorText(cause),
          })
        }
      }
      return sent
    },
  }
}

/**
 * 从插件 ctx 建出探针扫描器（真实接线）。抽出来是为了让集成测试能用假的 ctx 驱动。
 */
export function createCtxProbeScanner(
  ctx: any,
  options: {
    now?: () => number
    claim?: (sessionID: string) => boolean
    log?: (record: Record<string, unknown>) => void
    limit?: number
    enabled?: () => boolean
  } = {},
) {
  const write = options.log ?? log
  return createProbeScanner({
    listSessions: async () => {
      const items = asArray(await ctx.session.list({ limit: options.limit ?? 200, order: "desc" }))
      return items
        .filter((item) => isObject(item) && item.time?.archived === undefined)
        .map((item) => toProbeCandidate(item))
    },
    resolveRoot: async (sessionID) => {
      try {
        return await findRoot(ctx, sessionID)
      } catch {
        return undefined
      }
    },
    rootIsConfigured: async (rootID) => {
      const entries = asArray(await ctx.session.instructions.entry.list({ sessionID: rootID }))
      return entries.some((entry) => typeof entry?.key === "string" && entry.key.startsWith("superagent."))
    },
    sendProbe: async (sessionID, text) => {
      await ctx.session.prompt({ sessionID, text, delivery: "steer" })
    },
    claim: options.claim ?? claimProbe,
    log: write,
    now: options.now,
    enabled: options.enabled,
  })
}

/**
 * 定时扫描。`setIntervalFn` / `clearIntervalFn` 可注入，测试用来验证定时器被清理。
 */
export function startProbeTimer(
  scan: () => Promise<unknown>,
  options: {
    intervalMs?: number
    setIntervalFn?: (handler: () => void, ms: number) => any
    clearIntervalFn?: (handle: any) => void
  } = {},
) {
  const intervalMs = options.intervalMs ?? PROBE_INTERVAL_MS
  const set = options.setIntervalFn ?? setInterval
  const clear = options.clearIntervalFn ?? clearInterval
  const handle = set(() => {
    void scan()
  }, intervalMs)
  try {
    handle?.unref?.()
  } catch {}
  return {
    intervalMs,
    stop() {
      clear(handle)
    },
  }
}

/** 拒绝文案：把「还能怎么办」写清楚，避免模型以为只能等。 */
export function denyMessage(count: number, limit: number, rootID: string): string {
  return `Subagent 存在上限已满：当前${count}/上限${limit}，root=${rootID}（可等运行中的完成、调大上限，或用 sessionID 续跑已有子代理）`
}

/**
 * 切换成功后把 retry 决策改成「继续重试」：core 对 QuotaExceeded 默认判不重试，
 * 不翻转的话新模型要等用户下一条消息才生效。只改这一次，已切过的会话不再翻转。
 */
export function forceRetryAfterSwitch(event: any, switched: boolean): boolean {
  if (!switched || !isObject(event) || !isObject(event.decision)) return false
  event.decision = { retry: true, delay: FALLBACK_RETRY_DELAY_MS }
  return true
}

/** 沿 parentID 上溯到 family root（没有 parentID 即 root）。 */
async function findRoot(ctx: any, sessionID: string): Promise<string> {
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
async function readLimit(
  ctx: any,
  callerID: string,
  rootID: string,
): Promise<{ limit: number; source?: string }> {
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
async function readKeptSubagents(
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

export type RetryFailure = {
  sessionID: string
  rootID: string
  isRoot: boolean
  error: unknown
  /** 本次失败时用的模型（retry 事件的 `model`）。 */
  model?: unknown
  entries: any[]
  attempt?: number
}

export type QuotaFallbackDeps = {
  switchModel: (input: { sessionID: string; model: ModelRef }) => Promise<void>
  writeLimit: (input: { sessionID: string; limit: number }) => Promise<void>
  log: (record: Record<string, unknown>) => void
  now?: () => number
  tierDown?: boolean
}

/**
 * 限额备用模型状态机：按 sessionID 累计连续限额失败，达到阈值后切一次模型，
 * 并把 root 的 max-subagents 降一档。远端读写在调用方完成，这里只做判定与状态。
 */
export function createQuotaFallback(deps: QuotaFallbackDeps) {
  const failures = new Map<string, number>()
  const switched = new Set<string>()
  const now = deps.now ?? Date.now
  const tierDown = deps.tierDown ?? QUOTA_TIER_DOWN

  return {
    failuresOf(sessionID: string) {
      return failures.get(sessionID) ?? 0
    },
    hasSwitched(sessionID: string) {
      return switched.has(sessionID)
    },
    /** 任一 LLM 成功：清零连续失败，但保留「已切过」标记。 */
    reset(sessionID: string) {
      failures.delete(sessionID)
    },
    async onFailure(input: RetryFailure): Promise<{ switched: boolean; to?: ModelRef }> {
      if (!isQuotaFailure(input.error)) return { switched: false }
      const count = (failures.get(input.sessionID) ?? 0) + 1
      failures.set(input.sessionID, count)
      const base = {
        sessionID: input.sessionID,
        root: input.rootID,
        failures: count,
        attempt: input.attempt,
      }

      if (switched.has(input.sessionID)) {
        deps.log({ event: "fallback-already-switched", decision: "allow", ...base })
        return { switched: false }
      }

      const config = readFallbackConfig(input.entries)
      if (!config.enabled) {
        deps.log({ event: "fallback-disabled", decision: "allow", ...base })
        return { switched: false }
      }
      if (count < config.threshold) return { switched: false }

      const target = input.isRoot ? config.rootModel : config.subModel
      if (!target) {
        deps.log({
          event: "fallback-unconfigured",
          decision: "allow",
          ...base,
          kind: input.isRoot ? "root" : "subagent",
        })
        return { switched: false }
      }

      const from = formatModelRef(input.model)
      const to = formatModelRef(target)
      try {
        await deps.switchModel({ sessionID: input.sessionID, model: target })
      } catch (cause) {
        deps.log({ event: "fallback-switch-failed", decision: "error", ...base, from, to, cause: errorText(cause) })
        return { switched: false }
      }
      switched.add(input.sessionID)
      failures.set(input.sessionID, 0)
      deps.log({
        event: "fallback-model-switch",
        decision: "allow",
        ...base,
        from,
        to,
        at: new Date(now()).toISOString(),
      })

      if (tierDown) {
        const current = readMaxSubagents(input.entries)
        const next = downgradeLimit(current)
        if (next === undefined) {
          deps.log({ event: "quota-tier-down-skip", decision: "allow", root: input.rootID, limit: current })
        } else {
          try {
            await deps.writeLimit({ sessionID: input.rootID, limit: next })
            deps.log({
              event: "quota-tier-down",
              decision: "allow",
              root: input.rootID,
              from: current,
              to: next,
              at: new Date(now()).toISOString(),
            })
          } catch (cause) {
            deps.log({ event: "quota-tier-down-failed", decision: "error", root: input.rootID, from: current, to: next, cause: errorText(cause) })
          }
        }
      }

      return { switched: true, to: target }
    },
  }
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

export default {
  id: PLUGIN_ID,
  async setup(ctx: any) {
    // 宿主把 `@opencode/plugin/*` 作为运行时模块提供；拿不到就退回普通 Error
    // （promise adapter 会把普通 Error 包成 Tool.Error，message 保留）。
    let ToolError: any = null
    try {
      const mod: any = await import("@opencode/plugin/promise/tool")
      ToolError = typeof mod?.Error === "function" ? mod.Error : null
    } catch {
      ToolError = null
    }

    /** callID → 本次调用的登记信息。 */
    const pending = new Map<string, { rootID?: string; steerTarget?: string }>()
    /** root → 飞行中（子会话尚未创建）的 subagent 调用数。 */
    const flying = new Map<string, number>()
    /** 正在被 steer 的子会话：淘汰时避开。 */
    const steered = new Set<string>()

    /** 限额备用模型：连续失败计数与每会话只切一次的标记都在里面。 */
    const quotaFallback = createQuotaFallback({
      switchModel: async ({ sessionID, model }) => {
        await ctx.session.switchModel({ sessionID, model })
      },
      writeLimit: async ({ sessionID, limit }) => {
        await ctx.session.instructions.entry.put({ sessionID, key: MAX_SUBAGENTS_KEY, value: limit })
      },
      log,
      tierDown: QUOTA_TIER_DOWN,
    })

    /** critic.ts 认的 client：消息列表在顶层 `message.list`，V2 里由 `session.context` 提供。 */
    const criticClient = {
      session: {
        create: (input: any) => ctx.session.create(input),
        get: (input: any) => ctx.session.get(input),
        update: (input: any) => ctx.session.update(input),
        prompt: (input: any) => ctx.session.prompt(input),
        remove: (input: any) => ctx.session.remove(input),
      },
      message: {
        list: (input: any) => ctx.session.context({ sessionID: input.sessionID }),
      },
    }
    /** 同一子会话的复核不并发；review 仍然每次成功完成各做一次。 */
    const criticInFlight = new Set<string>()

    /** 子会话成功完成后的后台复核；任何异常都只进日志，不影响主流程。 */
    const reviewAfterSuccess = async (sessionID: string, claimID?: string) => {
      if (criticInFlight.has(sessionID)) return
      criticInFlight.add(sessionID)
      try {
        const child = await ctx.session.get({ sessionID })
        const rootID = await findRoot(ctx, sessionID)
        const entries = asArray(await ctx.session.instructions.entry.list({ sessionID: rootID }))
        if (!shouldCriticReview({ eventType: "session.execution.succeeded", childSessionID: sessionID, rootID, child, entries })) {
          return
        }
        // 同一完成事件可能被多个插件实例收到（reload 后旧订阅未必及时释放），
        // 在判定通过后用落盘声明保证只有一个实例真正复核。
        if (!claimCriticReview(claimID)) {
          log({ event: "critic-skip-duplicate", decision: "allow", childSessionID: sessionID, root: rootID, claim: claimID })
          return
        }
        const reportText = lastAssistantText(asArray(await ctx.session.context({ sessionID })))
        const result = await criticReview({ client: criticClient, childSessionID: sessionID, rootID, reportText }, { log })
        log({ event: "critic-finished", decision: "allow", childSessionID: sessionID, root: rootID, verdict: result.verdict })
      } catch (cause) {
        log({ event: "critic-hook-error", decision: "error", childSessionID: sessionID, cause: errorText(cause) })
      } finally {
        criticInFlight.delete(sessionID)
      }
    }

    const bump = (rootID: string, delta: number) => {
      const next = (flying.get(rootID) ?? 0) + delta
      if (next <= 0) flying.delete(rootID)
      else flying.set(rootID, next)
    }

    const before = await ctx.tool.hook("execute.before", async (event: any) => {
      // 总开关优先：停用时连是不是 subagent 都不判断，直接放行。
      if (!collabEnabled()) return
      // 快路径：不是 subagent 立即返回，不做任何查询。
      if (event?.tool !== TOOL_NAME) return
      const input = isObject(event.input) ? event.input : undefined
      const steerTarget =
        typeof input?.sessionID === "string" && input.sessionID.length > 0 ? input.sessionID : undefined
      const base = { sessionID: event.sessionID, callID: event.id, agent: event.agent }
      let reserved: string | undefined

      try {
        if (steerTarget) {
          // 续跑已有子会话：不占新槽，直接放行。登记 steer 目标，淘汰时避开它。
          pending.set(event.id, { steerTarget })
          steered.add(steerTarget)
          log({
            event: "subagent-steer",
            decision: "allow",
            root: null,
            count: null,
            exist: null,
            inflight: null,
            evicted: 0,
            limit: null,
            formula: "steer=no-slot",
            steerTarget,
            ...base,
          })
          return
        }

        const now = Date.now()
        let rootID = event.sessionID
        let limit = DEFAULT_MAX_SUBAGENTS
        let limitSource: string | undefined
        let children: Child[] = []
        try {
          rootID = await findRoot(ctx, event.sessionID)
          // 先占槽再看子会话：并发调用必须互相看见，否则会同时放行、超发。
          bump(rootID, 1)
          reserved = rootID
          pending.set(event.id, { rootID })
          const found = await readLimit(ctx, event.sessionID, rootID)
          limit = found.limit
          limitSource = found.source
          children = await listChildren(ctx, rootID, now)
        } catch (cause) {
          // 查询异常：fail-open，放行并留 error 日志。已占的槽要还回去。
          const inflightAtFailure = reserved ? (flying.get(reserved) ?? 0) : 0
          if (reserved) {
            bump(reserved, -1)
            pending.delete(event.id)
            reserved = undefined
          }
          log({
            event: "lookup-failed",
            decision: "error",
            root: rootID,
            count: null,
            exist: null,
            inflight: inflightAtFailure,
            evicted: 0,
            limit,
            formula: `exist=? inflight=${inflightAtFailure} total=? limit=${limit}`,
            cause: errorText(cause),
            ...base,
          })
          return
        }

        // 存在数 = 已有的非归档直接子会话；在途数 = 本 root 上还在飞的调用（含本次）。
        // 本次调用占的那个槽就是它在途里的这一份，判定与淘汰都不再另加一份，
        // 因此放行条件是 `存在数 + 在途数 <= 上限`。
        const inflight = () => flying.get(rootID) ?? 0
        let exist = children.length
        let count = exist + inflight()
        let evicted = 0
        const evictedIds: string[] = []

        if (isOverLimit(exist, inflight(), limit)) {
          // 淘汰前先读保护名单：root 链上的 `superagent.kept-subagents`。
          let kept: Set<string>
          try {
            kept = await readKeptSubagents(ctx, event.sessionID, rootID)
          } catch (cause) {
            // 读不到保护名单就不动数据：fail-open 放行本次调用。
            log({
              event: "kept-read-failed",
              decision: "allow",
              root: rootID,
              count,
              exist,
              inflight: inflight(),
              evicted: 0,
              limit,
              formula: `exist=${exist} inflight=${inflight()} total=${count} limit=${limit}`,
              cause: errorText(cause),
              ...base,
            })
            return
          }
          for (;;) {
            // 每轮都重新算一次：并发调用可能已经结束，槽位已经还回来了。
            count = exist + inflight()
            if (!isOverLimit(exist, inflight(), limit)) break
            const roundFormula = `exist=${exist} inflight=${inflight()} total=${count} limit=${limit}`
            const victim = pickVictim(children, steered, kept)
            if (!victim) break
            const victimID = victim.child.id
            try {
              await ctx.session.remove({ sessionID: victimID })
            } catch (cause) {
              log({
                event: "evict-failed",
                decision: "error",
                root: rootID,
                count,
                exist,
                inflight: inflight(),
                limit,
                victim: victimID,
                formula: roundFormula,
                cause: errorText(cause),
                ...base,
              })
              break
            }
            evicted++
            evictedIds.push(victimID)
            log({
              event: victim.reason === "stale-evict" ? "stale-evict" : "subagent-evict",
              decision: "allow",
              root: rootID,
              victim: victimID,
              reason: victim.reason,
              count,
              exist,
              inflight: inflight(),
              evicted,
              limit,
              formula: roundFormula,
              ...base,
            })
            children = await listChildren(ctx, rootID, now)
            exist = children.length
          }
        }

        // 判定快照：拒绝时槽位要还回去，日志按判定时刻的算式记。
        const decision = { count: exist + inflight(), exist, inflight: inflight() }
        const formula = `exist=${decision.exist} inflight=${decision.inflight} total=${decision.count} limit=${limit}`

        if (isOverLimit(decision.exist, decision.inflight, limit)) {
          // 拒绝：被拒绝的调用不会触发 execute.after，槽位要在这里还回去。
          bump(rootID, -1)
          reserved = undefined
          pending.delete(event.id)
          const message = denyMessage(decision.count, limit, rootID)
          log({
            event: "subagent-denied",
            decision: "deny",
            root: rootID,
            ...decision,
            evicted,
            limit,
            limitSource,
            evictedIds,
            children: children.map((child) => child.id),
            formula,
            message,
            ...base,
          })
          throw new DenyError(message)
        }

        log({
          event: "subagent-allowed",
          decision: "allow",
          root: rootID,
          ...decision,
          evicted,
          limit,
          limitSource,
          evictedIds,
          children: children.map((child) => child.id),
          formula,
          ...base,
        })
      } catch (cause) {
        if (cause instanceof DenyError) {
          if (ToolError) throw new ToolError({ message: cause.message })
          throw cause
        }
        // 意外异常：fail-open，不能把用户的 subagent 调用打挂。
        if (reserved) {
          bump(reserved, -1)
          pending.delete(event.id)
        }
        log({
          event: "hook-error",
          decision: "error",
          root: null,
          count: null,
          limit: null,
          cause: errorText(cause),
          ...base,
        })
      }
    })

    const after = await ctx.tool.hook("execute.after", async (event: any) => {
      // 停用时 before 从未登记，这里只需清理可能残留的登记（纯内部簿记，无外部副作用）。
      if (event?.tool !== TOOL_NAME) return
      try {
        const entry = pending.get(event.id)
        if (!entry) return
        pending.delete(event.id)
        if (entry.rootID) bump(entry.rootID, -1)
        if (entry.steerTarget) steered.delete(entry.steerTarget)
      } catch {
        // after 钩子抛错会波及工具体本身，这里绝不能抛。
      }
    })

    // 限额重试：core 在每次重试决策前触发 retry 钩子，此时的切换只影响下一 attempt，
    // 不会打断正在执行的轮次；切换成功时把决策翻成继续重试。钩子里的异常一律吞掉。
    const retry = await ctx.session.hook("retry", async (event: any) => {
      try {
        // 停用时不计数、不切换，连 root 都不查。
        if (!collabEnabled()) return
        if (!isQuotaFailure(event?.error)) return
        const sessionID = typeof event?.sessionID === "string" ? event.sessionID : undefined
        if (!sessionID) return
        const rootID = await findRoot(ctx, sessionID)
        const entries = asArray(await ctx.session.instructions.entry.list({ sessionID: rootID }))
        const outcome = await quotaFallback.onFailure({
          sessionID,
          rootID,
          isRoot: sessionID === rootID,
          error: event.error,
          model: event.model,
          entries,
          attempt: typeof event?.attempt === "number" ? event.attempt : undefined,
        })
        forceRetryAfterSwitch(event, outcome.switched)
      } catch (cause) {
        log({
          event: "fallback-hook-error",
          decision: "error",
          root: null,
          count: null,
          limit: null,
          sessionID: event?.sessionID,
          cause: errorText(cause),
        })
      }
    })

    // 成功即清零：step 成功（单次 LLM 调用成功）或整个执行成功都算。
    // 同一事件流顺带触发子会话复核：复核本身在后台跑，不阻塞消费循环。
    const resetAbort = new AbortController()
    const resetSubscription = (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.step.ended", "session.execution.succeeded"],
          signal: resetAbort.signal,
        })) {
          const sessionID = eventSessionID(event)
          if (!sessionID) continue
          quotaFallback.reset(sessionID)
          // 停用时复核不触发。
          if (event?.type === "session.execution.succeeded" && collabEnabled()) {
            void reviewAfterSuccess(sessionID, event?.id)
          }
        }
      } catch {
        // 事件流断开只是不再清零计数，不影响拦截与切换。
      }
    })()
    void resetSubscription

    // 超时状态探针：只探带 superagent 配置的 root 家族里的子会话。
    const probeScanner = createCtxProbeScanner(ctx, { enabled: () => collabEnabled() })
    const probeTimer = startProbeTimer(() => probeScanner.scan())

    pruneClaims()

    log({
      event: "setup",
      decision: "allow",
      root: null,
      count: null,
      limit: null,
      toolError: ToolError ? "Tool.Error" : "plain Error",
    })

    return () => {
      try {
        before?.dispose?.()
      } catch {}
      try {
        after?.dispose?.()
      } catch {}
      try {
        retry?.dispose?.()
      } catch {}
      try {
        resetAbort.abort()
      } catch {}
      try {
        probeTimer.stop()
      } catch {}
      log({ event: "dispose", decision: "allow", root: null, count: null, limit: null })
    }
  },
}
