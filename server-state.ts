/**
 * Server 运行时状态：路径、日志、跨实例声明与通用小工具。
 *
 * 这些函数只依赖文件系统和进程环境，不依赖插件 ctx；server 的钩子接线与
 * 扫描器都从这里取日志和声明入口，避免状态散落在入口文件里。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { DEFAULT_CONTEXT_WARN_TOKENS } from "./context-policy"

export const PLUGIN_ID = "superagent-agents-hardlimit"
export const TOOL_NAME = "subagent"
export const DEFAULT_MAX_SUBAGENTS = 5
export const MAX_SUBAGENTS_KEY = "superagent.max-subagents"
/** root 链上记录「保护中的子会话」的指令条目，值是逗号分隔的 sessionID 列表。 */
export const KEPT_SUBAGENTS_KEY = "superagent.kept-subagents"
/** 限额切换的目标模型：root 会话用前者，子会话用后者，值都是 `providerID/modelID`。 */
export const FALLBACK_MODEL_KEY = "superagent.fallback-model"
export const SUBAGENT_FALLBACK_MODEL_KEY = "superagent.subagent-fallback-model"
/** 连续限额失败多少次后切换，缺省 3。 */
export const FALLBACK_THRESHOLD_KEY = "superagent.fallback-threshold"
/** `"true"` / `"false"`，缺省启用。 */
export const FALLBACK_ENABLED_KEY = "superagent.fallback-enabled"
export const DEFAULT_FALLBACK_THRESHOLD = 3
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
/** 上下文压缩阈值：最近一次 assistant 调用的输入侧 token 数超过它才自动压缩（与面板同口径）。 */
export const CONTEXT_WARN_TOKENS = DEFAULT_CONTEXT_WARN_TOKENS
/** 视为「compact 已生效」的下降比例：当前长度较上次自动压缩时下降 ≥30% 就清掉声明。 */
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
/** 上下文压缩声明目录：同一子会话只自动压缩一次，并记着上次压缩时的长度。 */
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
export class DenyError extends Error {
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

/** 上下文压缩声明文件的路径；sessionID 里不允许出现路径分隔符。 */
export function contextClaimFile(sessionID: string, dir: string = ctxClaimDir()): string | undefined {
  const safe = (sessionID ?? "").replace(/[^A-Za-z0-9._-]/g, "")
  return safe ? path.join(dir, safe) : undefined
}

/** 读上次自动压缩时的上下文长度；没有声明或文件读不懂都返回 undefined。 */
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

/** 清掉上下文压缩声明（compact 生效、长度大幅下降后允许再次自动压缩）。 */
export function clearContextClaim(sessionID: string, dir: string = ctxClaimDir()) {
  const file = contextClaimFile(sessionID, dir)
  if (!file) return
  try {
    rmSync(file, { force: true })
  } catch {}
}

/**
 * 上下文压缩声明：`wx` 独占创建，先写成者独占；已有声明时只有
 * 「当前长度较上次压缩下降 ≥30%」才清掉重来，避免多实例重复压缩。
 */
export function claimContextCompaction(
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
export function pruneClaims(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
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

export function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (isObject(value) && Array.isArray(value.data)) return value.data
  return []
}

export function errorText(cause: unknown) {
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

export function contextDropped(previous: number | undefined, current: number): boolean {
  return previous !== undefined && previous > 0 && previous - current >= previous * CONTEXT_DROP_RATIO
}
