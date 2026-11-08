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
 * 旗舰子代理：
 *  - 新 root key `superagent.max-flagship-subagents`（默认 2，合法 0..20，非法回退 2，
 *    实际再受 `superagent.max-subagents` 总上限约束）；旗舰 = 与 root 同
 *    provider/model/variant，未知模型不按旗舰计。
 *  - 新建与 steer 前预测有效模型（`input.model ?? agent.model ?? parent.model`），
 *    存在数 + 在途数（含本次）分别计数；旗舰超限先淘汰最旧已完成旗舰，
 *    运行中/steer/保护名单不删，无可淘汰则明确拒绝。
 *  - `session.created` / `session.model.selected` 在 child 自身写或清
 *    `metadata["superagent.flagship"] = { model, at }`；root 切模型不清洗旧 child 标记。
 *
 * 保护子会话的模型硬约束：
 *  - 命中保护名单（`superagent.kept-subagents`）的子会话，steer 到它时模型也不可改：
 *    显式 `input.model`、或切换 agent 时 `agent.model` 带来的模型变化都被拒绝（ToolError，
 *    提示先取消保护）；同模型续跑、未指定模型且不换 agent 的普通 steer 照常放行。
 *  - 限额备用切换同样跳过保护中的会话：不计失败、不切模型、不强制重试（记 `fallback-kept-model`）。
 *  - 保护名单读不到时按无保护处理（fail-open）并记 `kept-read-failed`。
 *  - TUI 直接调 `session.switchModel` 的路径不在这里拦截，也不做模型回滚。
 *
 * 子代理复核（critic）：
 *  - 监听 `session.execution.succeeded`；只有 root 的 `superagent.critic-enabled`
 *    为真、且完成的是「root 家族里的非 root、非 critic 子会话」时才复核；
 *    `superagent.oversight-level`（child 优先，其次 root，默认 L2）为 L4 时强制复核。
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
 *
 * 超长上下文提醒（与面板 ctx 读数同口径）：
 *  - 复用同一个 5 分钟扫描周期：对带 `superagent.*` 指令条目的 root 家族里的子会话，
 *    取其最近一次 assistant 调用的输入 token 数（input + cache 读写，跳过 compact 之前的旧记录）。
 *  - 阈值复用 `context-policy.ts`：有模型窗口时 `min(300K, floor(window * 0.8))`，
 *    否则 300K；窗口经 `session.model` + `ctx.model.list` 的 `limit.context` 读取并缓存，
 *    查询失败回退 300K。严格超过阈值才向 **root**（主会话）发 steer 提醒，
 *    建议 compact；不再需要上下文时才删除，不是发给子代理。
 *  - 每个子会话只提醒一次（`ctx-claims/` 落盘声明，记着上次提醒时的 token 数）；
 *    若当前长度较上次提醒下降 ≥30%（compact 过），清掉声明，允许再次提醒。
 *  - 该 root 的协作总开关关闭、critic 会话、root 自身、已结束的子会话都跳过；发送失败只记日志。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { criticReview, isCriticSession, lastAssistantText } from "./critic"
import { DEFAULT_CONTEXT_WARN_TOKENS, contextWarnThreshold, modelContextWindow } from "./context-policy"
import { isFlagshipSession } from "./flagship"
import {
  FLAGSHIP_METADATA_KEY,
  effectiveFlagshipLimit,
  flagshipDenyMessage,
  flagshipFormula,
  hasFlagshipMarker,
  isFlagshipModel,
  isFlagshipOverLimit,
  normalizeFlagshipModel,
  pickFlagshipVictim,
  readMaxFlagshipSubagents,
  resolveNewSubagentModel,
  resolveSteerSubagentModel,
  sameFlagshipModel,
  withFlagshipMarker,
  withoutFlagshipMarker,
} from "./flagship-admission"
import { DEFAULT_OVERSIGHT_LEVEL } from "./oversight"
import { SUPERAGENT_SKILLS } from "./skills"

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

/** 监管等级：优先子会话条目，缺省 root，再缺省 L2。 */
export const OVERSIGHT_LEVEL_KEY = "superagent.oversight-level"
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
/** 上下文告警阈值：最近一次 assistant 调用的输入侧 token 数超过它才提醒（与面板同口径）。 */
export const CONTEXT_WARN_TOKENS = DEFAULT_CONTEXT_WARN_TOKENS
/** 视为「compact 过」的下降比例：当前长度较上次提醒时下降 ≥30% 就清掉声明。 */
export const CONTEXT_DROP_RATIO = 0.3
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
/** 上下文提醒声明目录：同一子会话只提醒一次，并记着上次提醒时的长度。 */
function ctxClaimDir(): string {
  return path.join(stateRoot(), "ctx-claims")
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
  /** 当前模型，用于旗舰判定。 */
  model?: unknown
  /** 会话元数据，含 `superagent.flagship` 持久标记。 */
  metadata?: Record<string, unknown>
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
 * 协作模式总开关的作用域是 root 会话：值就是该 root 的
 * `superagent.collab-enabled` 指令条目（`"true"` / `"false"`）。
 * 条目缺省、值不合法或读取失败都按启用处理（fail-open）。
 */
export const COLLAB_ENABLED_KEY = "superagent.collab-enabled"

export type CollabSwitchState = { enabled: boolean; reason: "configured" | "default" | "corrupt" }

/** 从一个 root 的指令条目解析开关；只有明确的 false 才停用。 */
export function readCollabState(entries: unknown): CollabSwitchState {
  const entry = asArray(entries).find((item) => item?.key === COLLAB_ENABLED_KEY)
  if (!entry) return { enabled: true, reason: "default" }
  if (typeof entry.value === "boolean") return { enabled: entry.value, reason: "configured" }
  if (typeof entry.value !== "string") return { enabled: true, reason: "corrupt" }
  const value = entry.value.trim().toLowerCase()
  if (value === "false") return { enabled: false, reason: "configured" }
  if (value === "true") return { enabled: true, reason: "configured" }
  return { enabled: true, reason: "corrupt" }
}

export function collabEnabledFromEntries(entries: unknown): boolean {
  return readCollabState(entries).enabled
}

/**
 * 读某个 root 家族的总开关。读失败按启用处理并留日志，
 * 避免一次查询异常把整族协作行为关死。
 */
async function readRootCollabEnabled(ctx: any, rootID: string): Promise<boolean> {
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
async function collabEnabledForSession(ctx: any, sessionID: string | undefined): Promise<boolean> {
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

/** 上下文提醒声明文件的路径；sessionID 里不允许出现路径分隔符。 */
export function contextClaimFile(sessionID: string, dir: string = ctxClaimDir()): string | undefined {
  const safe = (sessionID ?? "").replace(/[^A-Za-z0-9._-]/g, "")
  return safe ? path.join(dir, safe) : undefined
}

/** 读上次提醒时的上下文长度；没有声明或文件读不懂都返回 undefined。 */
export function readContextClaim(sessionID: string, dir: string = ctxClaimDir()): number | undefined {
  const file = contextClaimFile(sessionID, dir)
  if (!file) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    const tokens = isObject(parsed) ? parsed.tokens : undefined
    return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined
  } catch {
    return undefined
  }
}

/** 清掉上下文提醒声明（compact 之后允许再次提醒）。 */
export function clearContextClaim(sessionID: string, dir: string = ctxClaimDir()) {
  const file = contextClaimFile(sessionID, dir)
  if (!file) return
  try {
    rmSync(file, { force: true })
  } catch {}
}

/**
 * 上下文提醒声明：`wx` 独占创建，先写成者独占；已有声明时只有
 * 「当前长度较上次提醒下降 ≥30%」才清掉重来，避免多实例重复提醒。
 */
export function claimContextWarning(
  sessionID: string,
  tokens: number,
  dir: string = ctxClaimDir(),
): boolean {
  const file = contextClaimFile(sessionID, dir)
  if (!file) return true
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return false
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify({ tokens, at: new Date().toISOString() }), { flag: "wx" })
      return true
    } catch (cause) {
      if ((cause as any)?.code !== "EEXIST") return false
      const claimed = readContextClaim(sessionID, dir)
      // 声明文件读不懂（旧格式/半写）：清掉重试一次。
      if (claimed === undefined) {
        clearContextClaim(sessionID, dir)
        continue
      }
      if (!contextDropped(claimed, tokens)) return false
      clearContextClaim(sessionID, dir)
    }
  }
  return false
}

/** 清掉过期的声明，避免声明目录无限增长。 */
function pruneClaims(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs
  for (const dir of [criticClaimDir(), probeClaimDir(), ctxClaimDir()]) {
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

/** 从指令条目读监管等级；只有 0..4 的整数算合法，其余视作未设置。 */
export function readOversightLevel(entries: unknown): number | undefined {
  const entry = asArray(entries).find((item) => item?.key === OVERSIGHT_LEVEL_KEY)
  if (!entry) return undefined
  const raw = entry.value
  const parsed =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) return undefined
  return parsed
}

/** 子会话条目优先，其次 root 条目，最后默认 L2。 */
export function resolveOversightLevel(childEntries: unknown, rootEntries: unknown): number {
  return readOversightLevel(childEntries) ?? readOversightLevel(rootEntries) ?? DEFAULT_OVERSIGHT_LEVEL
}

/**
 * 复核触发判定：只复核「成功完成的、root 家族里的非 root、非 critic 子会话」。
 * L4 强制独立复核；L0-L3 遵循 root 的 `superagent.critic-enabled`。
 * 另外避开同一子会话的并发复核。
 */
export function shouldCriticReview(input: {
  eventType: string
  childSessionID: string
  rootID: string
  child: { title?: string; metadata?: Record<string, unknown> } | undefined
  entries: any[]
  inFlight?: ReadonlySet<string>
  /** 解析后的监管等级；缺省按 L0-L3 的开关规则处理。 */
  oversightLevel?: number
}): boolean {
  if (input.eventType !== "session.execution.succeeded") return false
  if (!input.childSessionID || input.childSessionID === input.rootID) return false
  if (isCriticSession(input.child)) return false
  if (input.inFlight?.has(input.childSessionID)) return false
  if (input.oversightLevel === 4) return true
  return readCriticEnabled(input.entries)
}

export type ProbeCandidate = {
  id: string
  outcome?: string | null
  busy?: number
  idle?: number
  title?: string
  metadata?: Record<string, unknown>
  /** 当前模型，用于按模型上下文窗口算提醒阈值。 */
  model?: unknown
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
    model: item?.model,
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
  /** 该 root 的协作总开关；缺省视为启用。 */
  rootIsEnabled?: (rootID: string) => Promise<boolean>
  sendProbe: (sessionID: string, text: string) => Promise<void>
  /** 跨实例去重：返回 false 表示别的实例已经探过这个会话。 */
  claim?: (sessionID: string) => boolean
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
      let candidates: ProbeCandidate[]
      try {
        candidates = await deps.listSessions()
      } catch (cause) {
        deps.log({ event: "probe-scan-failed", decision: "error", cause: errorText(cause) })
        return 0
      }
      /** root → 本轮是否启用；逐 root 判断，停用一个 root 不影响其他 root。 */
      const enabled = new Map<string, boolean>()
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
        let collab = enabled.get(rootID)
        if (collab === undefined) {
          try {
            collab = deps.rootIsEnabled ? await deps.rootIsEnabled(rootID) : true
          } catch (cause) {
            deps.log({ event: "probe-collab-failed", decision: "allow", root: rootID, cause: errorText(cause) })
            collab = true
          }
          enabled.set(rootID, collab)
        }
        if (!collab) continue
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
    rootIsEnabled: (rootID) => readRootCollabEnabled(ctx, rootID),
    log: write,
    now: options.now,
  })
}

/** 最近一次 assistant 调用的输入侧 token 数；无数据返回 undefined。 */
export function contextTokens(messages: ReadonlyArray<any> | undefined): number | undefined {
  if (!messages || messages.length === 0) return undefined
  // 与 TUI 面板同口径：跳过已经完成的 compact 之前的旧记录，取新一步的输入。
  const boundary = messages.findLastIndex((message) => message?.type === "compaction" && message?.status === "completed")
  for (let index = messages.length - 1; index > boundary; index -= 1) {
    const message = messages[index]
    if (message?.type !== "assistant" || !isObject(message.tokens)) continue
    const tokens = message.tokens
    const cache = isObject(tokens.cache) ? tokens.cache : {}
    const input = numberOrZero(tokens.input) + numberOrZero(cache.read) + numberOrZero(cache.write)
    return input > 0 ? input : undefined
  }
  return undefined
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** 是否已超过上下文告警阈值（严格大于；默认 300k）。 */
export function isContextOverLimit(
  tokens: number | undefined,
  limit = CONTEXT_WARN_TOKENS,
): tokens is number {
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens > limit
}

/** 当前长度较上次提醒时是否下降 ≥30%（视为 compact 过）。 */
export function contextDropped(previous: number | undefined, current: number): boolean {
  return previous !== undefined && previous > 0 && previous - current >= previous * CONTEXT_DROP_RATIO
}

/**
 * 该子会话是否进入上下文检查：critic 会话、已结束且不在运行中的都跳过；
 * root 自身与所属 root 的开关在扫描器里跳过。
 */
export function shouldCheckContext(candidate: ProbeCandidate): boolean {
  if (!candidate.id) return false
  if (isCriticSession(candidate)) return false
  if (candidate.outcome != null) {
    const running = candidate.busy !== undefined && (candidate.idle === undefined || candidate.busy > candidate.idle)
    if (!running) return false
  }
  return true
}

/** 发给 root 的提醒文案：优先 compact，只有不再需要上下文时才删除。 */
export function ctxWarningText(
  title: string | undefined,
  sessionID: string,
  tokens: number,
  limit = CONTEXT_WARN_TOKENS,
): string {
  const label = typeof title === "string" && title.trim().length > 0 ? title.trim() : "未命名"
  const k = Math.round(tokens / 1000)
  const limitK = Math.round(limit / 1000)
  return `[上下文提醒] 子代理「${label}」(${sessionID}) 当前上下文约 ${k}k tokens（>${limitK}k）。建议：需要保留上下文时对其执行 compact；不再需要上下文时才删除。`
}

export type CtxWarningScannerDeps = {
  /** 列出全部会话（root 与各层子会话都在内）。 */
  listSessions: () => Promise<ProbeCandidate[]>
  /** 沿 parentID 上溯到 family root。 */
  resolveRoot: (sessionID: string) => Promise<string | undefined>
  /** 该 root 是否带 superagent 配置（任意 `superagent.*` 指令条目）。 */
  rootIsConfigured: (rootID: string) => Promise<boolean>
  /** 读该会话最近一次 assistant 调用的输入 token 数。 */
  readTokens: (sessionID: string) => Promise<number | undefined>
  /** 按会话模型算提醒阈值；缺省 300K。读失败按默认值处理。 */
  readThreshold?: (candidate: ProbeCandidate) => Promise<number | undefined>
  /** 该 root 的协作总开关；缺省视为启用。 */
  rootIsEnabled?: (rootID: string) => Promise<boolean>
  /** 向 root 发 steer 提醒。 */
  sendWarn: (rootID: string, text: string) => Promise<void>
  /** 跨实例去重：返回 false 表示已经提醒过（且未 compact）。 */
  claim?: (sessionID: string, tokens: number) => boolean
  log: (record: Record<string, unknown>) => void
  now?: () => number
}

/**
 * 超长上下文扫描器。每个子会话只提醒一次；长度下降 ≥30% 后清声明、允许再次提醒。
 * 失败一律只记日志：读不到长度或发不出提醒都不影响会话本身。
 */
export function createCtxWarningScanner(deps: CtxWarningScannerDeps) {
  /** root → 是否带 superagent 配置；一个 root 只查一次。 */
  const configured = new Map<string, boolean>()
  return {
    async scan(): Promise<number> {
      let candidates: ProbeCandidate[]
      try {
        candidates = await deps.listSessions()
      } catch (cause) {
        deps.log({ event: "ctx-scan-failed", decision: "error", cause: errorText(cause) })
        return 0
      }
      /** root → 本轮是否启用；逐 root 判断，停用一个 root 不影响其他 root。 */
      const enabled = new Map<string, boolean>()
      let sent = 0
      for (const candidate of candidates) {
        if (!shouldCheckContext(candidate)) continue
        let rootID: string | undefined
        try {
          rootID = await deps.resolveRoot(candidate.id)
        } catch (cause) {
          deps.log({ event: "ctx-root-failed", decision: "error", childSessionID: candidate.id, cause: errorText(cause) })
          continue
        }
        // root 自己不是子代理。
        if (!rootID || rootID === candidate.id) continue
        let collab = enabled.get(rootID)
        if (collab === undefined) {
          try {
            collab = deps.rootIsEnabled ? await deps.rootIsEnabled(rootID) : true
          } catch (cause) {
            deps.log({ event: "ctx-collab-failed", decision: "allow", root: rootID, cause: errorText(cause) })
            collab = true
          }
          enabled.set(rootID, collab)
        }
        if (!collab) continue
        let managed = configured.get(rootID)
        if (managed === undefined) {
          try {
            managed = await deps.rootIsConfigured(rootID)
          } catch (cause) {
            deps.log({ event: "ctx-config-failed", decision: "error", root: rootID, cause: errorText(cause) })
            continue
          }
          configured.set(rootID, managed)
        }
        if (!managed) continue

        let tokens: number | undefined
        try {
          tokens = await deps.readTokens(candidate.id)
        } catch (cause) {
          deps.log({ event: "ctx-read-failed", decision: "error", childSessionID: candidate.id, root: rootID, cause: errorText(cause) })
          continue
        }
        if (tokens === undefined) continue

        // 按当前模型上下文窗口收紧阈值；读不到就沿用 300K。
        let threshold = CONTEXT_WARN_TOKENS
        if (deps.readThreshold) {
          try {
            const found = await deps.readThreshold(candidate)
            if (typeof found === "number" && Number.isFinite(found) && found > 0) threshold = Math.floor(found)
          } catch (cause) {
            deps.log({
              event: "ctx-limit-failed",
              decision: "error",
              childSessionID: candidate.id,
              root: rootID,
              note: "模型上下文窗口读取失败，按默认 300K",
              cause: errorText(cause),
            })
          }
        }

        const claimed = readContextClaim(candidate.id)
        const dropped = contextDropped(claimed, tokens)
        // compact 过：清掉声明，允许当前这轮重新提醒。
        if (dropped) clearContextClaim(candidate.id)
        if (!isContextOverLimit(tokens, threshold)) continue
        if (claimed !== undefined && !dropped) continue

        const claim = deps.claim ?? claimContextWarning
        if (!claim(candidate.id, tokens)) continue
        try {
          await deps.sendWarn(rootID, ctxWarningText(candidate.title, candidate.id, tokens, threshold))
          sent++
          deps.log({
            event: "ctx-warn",
            decision: "allow",
            childSessionID: candidate.id,
            tokens,
            threshold,
            root: rootID,
          })
        } catch (cause) {
          // 先登记再发：发送失败也不在 5 分钟后重复轰炸同一个会话。
          deps.log({
            event: "ctx-warn-failed",
            decision: "error",
            childSessionID: candidate.id,
            tokens,
            root: rootID,
            cause: errorText(cause),
          })
        }
      }
      return sent
    },
  }
}

/** 读会话消息列表：V2 插件 ctx 走 `session.context`，兼容顶层 `message.list`。 */
async function readSessionMessages(ctx: any, sessionID: string): Promise<any[]> {
  if (typeof ctx?.session?.context === "function") return asArray(await ctx.session.context({ sessionID }))
  if (typeof ctx?.message?.list === "function") return asArray(await ctx.message.list({ sessionID }))
  return []
}

/**
 * 模型上下文窗口查询：`ctx.model.list` 拿 `limit.context`，按 provider/model
 * 缓存成功结果；查询失败返回 undefined（沿用默认 300K）并留日志。
 */
export function createModelContextWindowLookup(ctx: any, write: (record: Record<string, unknown>) => void = log) {
  const cache = new Map<string, number>()
  return async (model: unknown): Promise<number | undefined> => {
    const ref = parseModelRef(model)
    if (!ref) return undefined
    const key = `${ref.providerID}/${ref.id}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    try {
      if (typeof ctx?.model?.list !== "function") return undefined
      const output = await ctx.model.list()
      const items = asArray(isObject(output) && Array.isArray(output.data) ? output.data : output)
      const found = items.find(
        (item) => item?.providerID === ref.providerID && (item?.id === ref.id || item?.modelID === ref.id),
      )
      const window = modelContextWindow(found)
      if (window !== undefined) cache.set(key, window)
      return window
    } catch (cause) {
      write({
        event: "ctx-model-lookup-failed",
        decision: "error",
        model: key,
        note: "模型上下文窗口读取失败，按默认 300K",
        cause: errorText(cause),
      })
      return undefined
    }
  }
}

/**
 * 从插件 ctx 建出超长上下文扫描器（真实接线）。抽出来让集成测试能用假的 ctx 驱动。
 */
export function createCtxContextWarningScanner(
  ctx: any,
  options: {
    now?: () => number
    claim?: (sessionID: string, tokens: number) => boolean
    log?: (record: Record<string, unknown>) => void
    limit?: number
  } = {},
) {
  const write = options.log ?? log
  const windowOf = createModelContextWindowLookup(ctx, write)
  return createCtxWarningScanner({
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
    readTokens: async (sessionID) => contextTokens(await readSessionMessages(ctx, sessionID)),
    readThreshold: async (candidate) => {
      let model = candidate.model
      if (model === undefined) {
        try {
          const info = await ctx.session.get({ sessionID: candidate.id })
          model = isObject(info) ? info.model : undefined
        } catch (cause) {
          write({
            event: "ctx-model-read-failed",
            decision: "error",
            childSessionID: candidate.id,
            note: "会话模型读取失败，按默认 300K",
            cause: errorText(cause),
          })
          return CONTEXT_WARN_TOKENS
        }
      }
      const window = await windowOf(model)
      if (window === undefined) return CONTEXT_WARN_TOKENS
      return contextWarnThreshold({ limit: { context: window } })
    },
    sendWarn: async (rootID, text) => {
      await ctx.session.prompt({ sessionID: rootID, text, delivery: "steer" })
    },
    claim: options.claim ?? claimContextWarning,
    rootIsEnabled: (rootID) => readRootCollabEnabled(ctx, rootID),
    log: write,
    now: options.now,
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

/**
 * 随插件注册原生 Skills：用 `ctx.skill.transform` 一次性加入静态流程资产。
 * 已存在同名技能（id 相同）不覆盖；任何失败只记 `skills-register-failed`，不阻断 setup。
 */
export async function registerSuperagentSkills(ctx: any, write: (record: Record<string, unknown>) => void = log) {
  if (typeof ctx?.skill?.transform !== "function") return undefined
  try {
    const registration = await ctx.skill.transform((editor: any) => {
      for (const skill of SUPERAGENT_SKILLS) {
        try {
          if (typeof editor?.get === "function" && editor.get(skill.id)) continue
          editor.add({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            path: skill.path,
            content: skill.content,
          })
        } catch (cause) {
          write({
            event: "skills-register-failed",
            decision: "error",
            skill: skill.id,
            cause: errorText(cause),
          })
        }
      }
    })
    write({ event: "skills-registered", decision: "allow", count: SUPERAGENT_SKILLS.length })
    return registration
  } catch (cause) {
    write({ event: "skills-register-failed", decision: "error", cause: errorText(cause) })
    return undefined
  }
}

/** 读 agent 配置（模型继承用）；拿不到按缺省处理，不阻断主流程。 */
async function readAgentInfo(ctx: any, agentID: unknown): Promise<any | undefined> {
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

async function readSessionModel(ctx: any, sessionID: string): Promise<unknown> {
  try {
    const info = await ctx.session.get({ sessionID })
    return isObject(info) ? info.model : undefined
  } catch {
    return undefined
  }
}

async function readSessionMetadata(ctx: any, sessionID: string): Promise<Record<string, unknown> | undefined> {
  try {
    const info = await ctx.session.get({ sessionID })
    return isObject(info) && isObject(info.metadata) ? info.metadata : undefined
  } catch {
    return undefined
  }
}

function eventData(event: any): Record<string, any> {
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
 * `session.created`：child 与 parent 当前模型一致时在 child 自身写旗舰标记；
 * 不一致时清掉可能继承来的旧标记。未知模型一律不判定（fail-open）。
 */
export async function handleSessionCreated(ctx: any, event: any): Promise<void> {
  const data = eventData(event)
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  const parentID = typeof data.parentID === "string" ? data.parentID : undefined
  if (!sessionID || !parentID) return
  const title = typeof data.title === "string" ? data.title : undefined
  const metadata = isObject(data.metadata) ? data.metadata : undefined
  if (isCriticSession({ title, metadata })) return
  const childModel = data.model ?? (await readSessionModel(ctx, sessionID))
  const parentModel = await readSessionModel(ctx, parentID)
  if (!normalizeFlagshipModel(childModel) || !normalizeFlagshipModel(parentModel)) return
  if (sameFlagshipModel(childModel, parentModel)) {
    await markFlagshipSession(ctx, { sessionID, parentID, model: childModel, metadata })
  } else {
    await clearFlagshipSession(ctx, { sessionID, parentID, reason: "created-model-mismatch" })
  }
}

/**
 * `session.model.selected`：只处理有 parent 的 child。child 切到与当前 parent
 * 相同的模型就标记，切走就清掉自己的标记。root 切模型不遍历、不清洗旧 child 标记。
 */
export async function handleSessionModelSelected(ctx: any, event: any): Promise<void> {
  const data = eventData(event)
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  if (!sessionID) return
  const info = await ctx.session.get({ sessionID })
  if (!isObject(info) || typeof info.parentID !== "string" || !info.parentID) return
  if (isCriticSession(info)) return
  const parent = await ctx.session.get({ sessionID: info.parentID })
  const parentModel = isObject(parent) ? parent.model : undefined
  const model = data.model ?? info.model
  if (!normalizeFlagshipModel(model) || !normalizeFlagshipModel(parentModel)) return
  if (sameFlagshipModel(model, parentModel)) {
    await markFlagshipSession(ctx, { sessionID, parentID: info.parentID, model })
  } else {
    await clearFlagshipSession(ctx, { sessionID, parentID: info.parentID, reason: "model-switched" })
  }
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

/**
 * 读保护名单的容错版本：读失败按「没有保护」处理（fail-open），并留日志。
 * 一次查询异常不该把模型硬约束整体关死。
 */
async function readKeptSubagentsSafe(
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

    // 原生 Skills 是静态流程资产，注册与协作总开关无关；失败只记日志。
    const skillRegistration = await registerSuperagentSkills(ctx)

    /** callID → 本次调用的登记信息；flagshipRoot 记本次占的旗舰槽。 */
    const pending = new Map<string, { rootID?: string; steerTarget?: string; flagshipRoot?: string }>()
    /** root → 飞行中（子会话尚未创建）的 subagent 调用数。 */
    const flying = new Map<string, number>()
    /** root → 飞行中的旗舰 subagent 调用数（含本次调用自己的槽）。 */
    const flyingFlagship = new Map<string, number>()
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
        let rootEntries: any[] = []
        let rootReadFailed = false
        try {
          rootEntries = asArray(await ctx.session.instructions.entry.list({ sessionID: rootID }))
        } catch (cause) {
          rootReadFailed = true
          log({
            event: "collab-read-failed",
            decision: "allow",
            root: rootID,
            note: "开关读取失败，按启用处理；critic 读取失败保持关闭",
            cause: errorText(cause),
          })
        }
        // 总开关按 root 生效：本 root 停用时不发复核，L4 也不能越过总开关。
        if (!collabEnabledFromEntries(rootEntries)) return
        let childEntries: any[] = []
        let childReadFailed = false
        try {
          childEntries = asArray(await ctx.session.instructions.entry.list({ sessionID }))
        } catch (cause) {
          childReadFailed = true
          log({
            event: "oversight-child-read-failed",
            decision: "allow",
            childSessionID: sessionID,
            root: rootID,
            note: "子会话监管等级读取失败，按 root 等级处理",
            cause: errorText(cause),
          })
        }
        const childLevel = readOversightLevel(childEntries)
        const rootLevel = readOversightLevel(rootEntries)
        const level = childLevel ?? rootLevel ?? DEFAULT_OVERSIGHT_LEVEL
        log({
          event: "critic-level",
          decision: "allow",
          childSessionID: sessionID,
          root: rootID,
          childLevel: childLevel ?? null,
          rootLevel: rootLevel ?? null,
          level,
          childReadFailed,
          rootReadFailed,
        })
        // root 条目读失败时无法确认监管等级：保持 fail-closed，不凭 L4 触发复核。
        if (
          !shouldCriticReview({
            eventType: "session.execution.succeeded",
            childSessionID: sessionID,
            rootID,
            child,
            entries: rootEntries,
            oversightLevel: rootReadFailed ? undefined : level,
          })
        ) {
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

    const bumpFlagship = (rootID: string, delta: number) => {
      const next = (flyingFlagship.get(rootID) ?? 0) + delta
      if (next <= 0) flyingFlagship.delete(rootID)
      else flyingFlagship.set(rootID, next)
    }

    const before = await ctx.tool.hook("execute.before", async (event: any) => {
      // 快路径：不是 subagent 立即返回，不做任何查询。
      if (event?.tool !== TOOL_NAME) return
      // 总开关按 root 生效：本 root 停用时直接放行，steer 登记等副作用也不发生。
      const callerSessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
      if (!(await collabEnabledForSession(ctx, callerSessionID))) return
      const input = isObject(event.input) ? event.input : undefined
      const steerTarget =
        typeof input?.sessionID === "string" && input.sessionID.length > 0 ? input.sessionID : undefined
      const base = { sessionID: event.sessionID, callID: event.id, agent: event.agent }
      const explicitModel =
        typeof input?.model === "string" && input.model.trim() !== "" ? input.model : undefined
      let reserved: string | undefined
      let reservedFlagship: string | undefined

      /** 归还本次调用占的槽（总槽与旗舰槽），before 拒绝或异常时用。 */
      const releaseReservation = () => {
        const entry = pending.get(event.id)
        pending.delete(event.id)
        const root = reserved ?? entry?.rootID
        if (root) bump(root, -1)
        const flagRoot = reservedFlagship ?? entry?.flagshipRoot
        if (flagRoot) bumpFlagship(flagRoot, -1)
        reserved = undefined
        reservedFlagship = undefined
      }
      const reserveFlagship = (rootID: string) => {
        bumpFlagship(rootID, 1)
        reservedFlagship = rootID
        const entry = pending.get(event.id)
        if (entry) entry.flagshipRoot = rootID
        else pending.set(event.id, { flagshipRoot: rootID })
      }

      try {
        if (steerTarget) {
          // 续跑已有子会话：不占新的总槽。若把普通 child 切成旗舰，仍要占旗舰槽。
          pending.set(event.id, { steerTarget })
          steered.add(steerTarget)
          let steerRoot: string | undefined
          let targetFlagship = false
          let alreadyFlagship = false
          let flagLimit: number | undefined
          let flagExist = 0
          let flagInflight = 0
          let flagEvicted = 0
          const evictedIds: string[] = []
          try {
            steerRoot = await findRoot(ctx, steerTarget)
            const target = await ctx.session.get({ sessionID: steerTarget })
            const targetModel = isObject(target) ? target.model : undefined
            const rootModel = await readSessionModel(ctx, steerRoot)
            const agent = await readAgentInfo(ctx, input?.agent)
            const switched = isObject(target) && agent ? target.agent !== agent.id : false
            // 保护中的子会话：模型也不可改。显式 model、或切换 agent 带来的模型变化都要拦；
            // 同模型续跑与不换 agent 的普通 steer 照常放行。
            const keptForSteer = await readKeptSubagentsSafe(ctx, event.sessionID, steerRoot, base)
            if (keptForSteer?.has(steerTarget)) {
              const change = detectSteerModelChange({
                explicitModel: explicitModel,
                agentModel: agent?.model,
                switched,
                existingModel: targetModel,
              })
              if (change) {
                const message = keptModelDenyMessage({
                  sessionID: steerTarget,
                  from: change.from,
                  to: change.to,
                })
                releaseReservation()
                steered.delete(steerTarget)
                log({
                  event: "kept-model-denied",
                  decision: "deny",
                  reason: "kept-model-locked",
                  root: steerRoot,
                  steerTarget,
                  from: change.from ?? null,
                  to: change.to ?? null,
                  message,
                  ...base,
                })
                throw new DenyError(message)
              }
            }
            const predicted = resolveSteerSubagentModel({
              inputModel: explicitModel,
              agentModel: agent?.model,
              existingModel: targetModel,
              switched,
            })
            targetFlagship = isFlagshipModel(predicted, rootModel)
            alreadyFlagship = isObject(target)
              ? isFlagshipSession(
                  { model: target.model, metadata: isObject(target.metadata) ? target.metadata : undefined },
                  rootModel,
                )
              : false
            if (targetFlagship && !alreadyFlagship) {
              // 已旗舰的 steer 不重复计数；普通 child → 旗舰才占新旗舰槽。
              reserveFlagship(steerRoot)
              const found = await readLimit(ctx, event.sessionID, steerRoot)
              flagLimit = effectiveFlagshipLimit(readMaxFlagshipSubagents(found.entries), found.limit)
              let children = await listChildren(ctx, steerRoot, Date.now())
              const existOf = () => children.filter((child) => isFlagshipSession(child, rootModel)).length
              const inflightOf = () => flyingFlagship.get(steerRoot!) ?? 0
              flagExist = existOf()
              flagInflight = inflightOf()
              if (isFlagshipOverLimit(flagExist, flagInflight, flagLimit)) {
                let kept: Set<string> | undefined
                try {
                  kept = await readKeptSubagents(ctx, event.sessionID, steerRoot)
                } catch (cause) {
                  log({
                    event: "kept-read-failed",
                    decision: "allow",
                    root: steerRoot,
                    note: "保护名单读取失败，旗舰 switch 放行不淘汰",
                    cause: errorText(cause),
                    ...base,
                  })
                }
                if (kept) {
                  for (;;) {
                    flagExist = existOf()
                    flagInflight = inflightOf()
                    if (!isFlagshipOverLimit(flagExist, flagInflight, flagLimit)) break
                    const roundFormula = flagshipFormula(flagExist, flagInflight, flagLimit)
                    const flagships = children.filter((child) => isFlagshipSession(child, rootModel))
                    const victim = pickFlagshipVictim(flagships, steered, kept)
                    if (!victim) break
                    try {
                      await ctx.session.remove({ sessionID: victim.id })
                    } catch (cause) {
                      log({
                        event: "flagship-evict-failed",
                        decision: "error",
                        root: steerRoot,
                        victim: victim.id,
                        formula: roundFormula,
                        cause: errorText(cause),
                        ...base,
                      })
                      break
                    }
                    flagEvicted++
                    evictedIds.push(victim.id)
                    log({
                      event: "flagship-evict",
                      decision: "allow",
                      root: steerRoot,
                      victim: victim.id,
                      reason: "steer-switch",
                      count: flagExist + flagInflight,
                      exist: flagExist,
                      inflight: flagInflight,
                      evicted: flagEvicted,
                      limit: flagLimit,
                      formula: roundFormula,
                      ...base,
                    })
                    children = await listChildren(ctx, steerRoot, Date.now())
                  }
                }
              }
              flagExist = existOf()
              flagInflight = inflightOf()
              if (isFlagshipOverLimit(flagExist, flagInflight, flagLimit)) {
                releaseReservation()
                steered.delete(steerTarget)
                const message = flagshipDenyMessage({
                  count: flagExist + flagInflight,
                  limit: flagLimit,
                  rootID: steerRoot,
                })
                log({
                  event: "subagent-denied",
                  decision: "deny",
                  reason: "flagship-limit",
                  root: steerRoot,
                  count: flagExist + flagInflight,
                  exist: flagExist,
                  inflight: flagInflight,
                  evicted: flagEvicted,
                  limit: null,
                  limitSource: null,
                  flagshipExist: flagExist,
                  flagshipInflight: flagInflight,
                  flagshipLimit: flagLimit,
                  evictedIds,
                  formula: `steer=no-slot ${flagshipFormula(flagExist, flagInflight, flagLimit)}`,
                  message,
                  ...base,
                })
                throw new DenyError(message)
              }
            }
          } catch (cause) {
            if (cause instanceof DenyError) throw cause
            // 预测失败不阻断 steer（fail-open）；已占的旗舰槽要还回去。
            if (reservedFlagship) {
              steered.delete(steerTarget)
              releaseReservation()
            }
            log({
              event: "flagship-steer-skip",
              decision: "allow",
              root: steerRoot ?? null,
              note: "旗舰判定失败，按普通 steer 放行",
              steerTarget,
              cause: errorText(cause),
              ...base,
            })
          }
          log({
            event: "subagent-steer",
            decision: "allow",
            root: steerRoot ?? null,
            count: null,
            exist: null,
            inflight: null,
            evicted: flagEvicted,
            limit: null,
            formula: "steer=no-slot",
            steerTarget,
            flagship: targetFlagship,
            alreadyFlagship,
            flagshipExist: targetFlagship && !alreadyFlagship ? flagExist : null,
            flagshipInflight: targetFlagship && !alreadyFlagship ? flagInflight : null,
            flagshipLimit: targetFlagship && !alreadyFlagship ? (flagLimit ?? null) : null,
            flagshipFormula:
              targetFlagship && !alreadyFlagship && flagLimit !== undefined
                ? flagshipFormula(flagExist, flagInflight, flagLimit)
                : null,
            evictedIds,
            ...base,
          })
          return
        }

        const now = Date.now()
        let rootID = event.sessionID
        let limit = DEFAULT_MAX_SUBAGENTS
        let limitSource: string | undefined
        let configEntries: any[] | undefined
        let children: Child[] = []
        let rootModel: unknown
        let predictedFlagship = false
        let flagLimit: number | undefined
        try {
          rootID = await findRoot(ctx, event.sessionID)
          // 先占槽再看子会话：并发调用必须互相看见，否则会同时放行、超发。
          bump(rootID, 1)
          reserved = rootID
          pending.set(event.id, { rootID })
          const found = await readLimit(ctx, event.sessionID, rootID)
          limit = found.limit
          limitSource = found.source
          configEntries = found.entries
          children = await listChildren(ctx, rootID, now)
          // 预判本次新建是否会落到旗舰模型：input.model ?? agent.model ?? parent.model。
          rootModel = await readSessionModel(ctx, rootID)
          const callerModel = await readSessionModel(ctx, event.sessionID)
          const agent = await readAgentInfo(ctx, input?.agent)
          const predicted = resolveNewSubagentModel({
            inputModel: explicitModel,
            agentModel: agent?.model,
            parentModel: callerModel,
          })
          predictedFlagship = isFlagshipModel(predicted, rootModel)
          if (predictedFlagship) {
            reserveFlagship(rootID)
            flagLimit = effectiveFlagshipLimit(readMaxFlagshipSubagents(configEntries), limit)
          }
        } catch (cause) {
          // 查询异常：fail-open，放行并留 error 日志。已占的槽要还回去。
          const inflightAtFailure = reserved ? (flying.get(reserved) ?? 0) : 0
          releaseReservation()
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
        const flagshipExist = () => children.filter((child) => isFlagshipSession(child, rootModel)).length
        const needsFlagshipEviction = () =>
          predictedFlagship &&
          flagLimit !== undefined &&
          isFlagshipOverLimit(flagshipExist(), flyingFlagship.get(rootID) ?? 0, flagLimit)
        let kept: Set<string> | undefined

        if (isOverLimit(exist, inflight(), limit) || needsFlagshipEviction()) {
          // 淘汰前先读保护名单：root 链上的 `superagent.kept-subagents`。
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
        }

        if (isOverLimit(exist, inflight(), limit)) {
          const protectedIDs = kept ?? new Set<string>()
          for (;;) {
            // 每轮都重新算一次：并发调用可能已经结束，槽位已经还回来了。
            count = exist + inflight()
            if (!isOverLimit(exist, inflight(), limit)) break
            const roundFormula = `exist=${exist} inflight=${inflight()} total=${count} limit=${limit}`
            const victim = pickVictim(children, steered, protectedIDs)
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

        // 旗舰上限独立于总上限：优先淘汰最旧已完成旗舰；运行中/steer/保护的都不动。
        let flagshipEvicted = 0
        if (predictedFlagship && flagLimit !== undefined) {
          const protectedIDs = kept ?? new Set<string>()
          for (;;) {
            const flagExist = flagshipExist()
            const flagInflight = flyingFlagship.get(rootID) ?? 0
            if (!isFlagshipOverLimit(flagExist, flagInflight, flagLimit)) break
            const roundFormula = flagshipFormula(flagExist, flagInflight, flagLimit)
            const flagships = children.filter((child) => isFlagshipSession(child, rootModel))
            const victim = pickFlagshipVictim(flagships, steered, protectedIDs)
            if (!victim) break
            try {
              await ctx.session.remove({ sessionID: victim.id })
            } catch (cause) {
              log({
                event: "flagship-evict-failed",
                decision: "error",
                root: rootID,
                victim: victim.id,
                formula: roundFormula,
                cause: errorText(cause),
                ...base,
              })
              break
            }
            flagshipEvicted++
            evicted++
            evictedIds.push(victim.id)
            log({
              event: "flagship-evict",
              decision: "allow",
              root: rootID,
              victim: victim.id,
              reason: "flagship-limit",
              count: flagExist + flagInflight,
              exist: flagExist,
              inflight: flagInflight,
              evicted: flagshipEvicted,
              limit: flagLimit,
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
        const flagExist = predictedFlagship ? flagshipExist() : undefined
        const flagInflight = predictedFlagship ? (flyingFlagship.get(rootID) ?? 0) : undefined
        const flagFormula =
          predictedFlagship && flagLimit !== undefined
            ? flagshipFormula(flagExist ?? 0, flagInflight ?? 0, flagLimit)
            : undefined
        const flagshipFields = predictedFlagship
          ? {
              flagship: true,
              flagshipExist: flagExist,
              flagshipInflight: flagInflight,
              flagshipLimit: flagLimit,
              flagshipEvicted,
              flagshipFormula: flagFormula,
            }
          : { flagship: false }

        if (isOverLimit(decision.exist, decision.inflight, limit)) {
          // 拒绝：被拒绝的调用不会触发 execute.after，槽位要在这里还回去。
          releaseReservation()
          const message = denyMessage(decision.count, limit, rootID)
          log({
            event: "subagent-denied",
            decision: "deny",
            reason: "total-limit",
            root: rootID,
            ...decision,
            evicted,
            limit,
            limitSource,
            evictedIds,
            children: children.map((child) => child.id),
            formula,
            message,
            ...flagshipFields,
            ...base,
          })
          throw new DenyError(message)
        }

        if (
          predictedFlagship &&
          flagLimit !== undefined &&
          isFlagshipOverLimit(flagExist ?? 0, flagInflight ?? 0, flagLimit)
        ) {
          // 旗舰槽不够且没有可淘汰的已完成旗舰：明确拒绝，不静默超发。
          releaseReservation()
          const message = flagshipDenyMessage({
            count: (flagExist ?? 0) + (flagInflight ?? 0),
            limit: flagLimit,
            rootID,
          })
          log({
            event: "subagent-denied",
            decision: "deny",
            reason: "flagship-limit",
            root: rootID,
            ...decision,
            evicted,
            limit,
            limitSource,
            evictedIds,
            children: children.map((child) => child.id),
            formula: `${formula} ${flagFormula ?? ""}`.trim(),
            message,
            ...flagshipFields,
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
          formula: `${formula} ${flagFormula ?? ""}`.trim(),
          ...flagshipFields,
          ...base,
        })
      } catch (cause) {
        if (cause instanceof DenyError) {
          releaseReservation()
          if (ToolError) throw new ToolError({ message: cause.message })
          throw cause
        }
        // 意外异常：fail-open，不能把用户的 subagent 调用打挂。
        if (steerTarget) steered.delete(steerTarget)
        releaseReservation()
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
        if (entry.flagshipRoot) bumpFlagship(entry.flagshipRoot, -1)
        if (entry.steerTarget) steered.delete(entry.steerTarget)
      } catch {
        // after 钩子抛错会波及工具体本身，这里绝不能抛。
      }
    })

    // 限额重试：core 在每次重试决策前触发 retry 钩子，此时的切换只影响下一 attempt，
    // 不会打断正在执行的轮次；切换成功时把决策翻成继续重试。钩子里的异常一律吞掉。
    const retry = await ctx.session.hook("retry", async (event: any) => {
      try {
        if (!isQuotaFailure(event?.error)) return
        const sessionID = typeof event?.sessionID === "string" ? event.sessionID : undefined
        if (!sessionID) return
        const rootID = await findRoot(ctx, sessionID)
        // 总开关按 root 生效：本 root 停用时不计失败、不切模型。
        if (!(await readRootCollabEnabled(ctx, rootID))) return
        // 保护中的子会话不参与限额备用切换：不计失败、不切模型、不强制重试。
        const keptForFallback = await readKeptSubagentsSafe(ctx, sessionID, rootID, { sessionID })
        if (keptForFallback?.has(sessionID)) {
          log({
            event: "fallback-kept-model",
            decision: "allow",
            root: rootID,
            sessionID,
            note: "受保护子会话：限额失败不计失败、不切模型、不强制重试",
          })
          return
        }
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
          types: ["session.step.ended", "session.execution.succeeded", "session.created", "session.model.selected"],
          signal: resetAbort.signal,
        })) {
          if (event?.type === "session.created" || event?.type === "session.model.selected") {
            try {
              if (event.type === "session.created") await handleSessionCreated(ctx, event)
              else await handleSessionModelSelected(ctx, event)
            } catch (cause) {
              log({
                event: "flagship-marker-failed",
                decision: "error",
                type: event.type,
                childSessionID: eventSessionID(event),
                cause: errorText(cause),
              })
            }
            continue
          }
          const sessionID = eventSessionID(event)
          if (!sessionID) continue
          quotaFallback.reset(sessionID)
          // 复核在内部按该会话所属 root 的开关短路。
          if (event?.type === "session.execution.succeeded") {
            void reviewAfterSuccess(sessionID, event?.id)
          }
        }
      } catch {
        // 事件流断开只是不再清零计数，不影响拦截与切换。
      }
    })()
    void resetSubscription

    // 超时状态探针：只探带 superagent 配置且当前 root 启用协作的家族里的子会话。
    const probeScanner = createCtxProbeScanner(ctx)
    // 超长上下文提醒：同一个 5 分钟周期内逐 root 判断开关。
    const ctxScanner = createCtxContextWarningScanner(ctx)
    const probeTimer = startProbeTimer(async () => {
      await Promise.allSettled([probeScanner.scan(), ctxScanner.scan()])
    })

    pruneClaims()

    log({
      event: "setup",
      decision: "allow",
      root: null,
      count: null,
      limit: null,
      toolError: ToolError ? "Tool.Error" : "plain Error",
    })

    return async () => {
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
      try {
        await skillRegistration?.dispose?.()
      } catch {}
      log({ event: "dispose", decision: "allow", root: null, count: null, limit: null })
    }
  },
}
