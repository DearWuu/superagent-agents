/**
 * Server 的定时扫描器：超时状态探针与超长上下文自动压缩。
 *
 * 扫描器只依赖注入的会话查询/compact 回调与状态层声明，入口文件只负责
 * 把它们接到真实 ctx 并启动定时器。
 */

import { isCriticSession } from "./critic"
import { contextWarnThreshold, modelContextWindow } from "./context-policy"
import { parseModelRef } from "./server-models"
import { findRoot, readRootCollabEnabled } from "./server-session"
import {
  CONTEXT_WARN_TOKENS,
  PROBE_AFTER_MS,
  PROBE_INTERVAL_MS,
  PROBE_TEXT,
  asArray,
  claimContextCompaction,
  claimProbe,
  clearContextClaim,
  contextDropped,
  errorText,
  isObject,
  log,
  readContextClaim,
} from "./server-state"

export type ProbeCandidate = {
  id: string
  outcome?: string | null
  busy?: number
  idle?: number
  title?: string
  metadata?: Record<string, unknown>
  /** 当前模型，用于按模型上下文窗口算压缩阈值。 */
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

export type CtxCompactionScannerDeps = {
  /** 列出全部会话（root 与各层子会话都在内）。 */
  listSessions: () => Promise<ProbeCandidate[]>
  /** 沿 parentID 上溯到 family root。 */
  resolveRoot: (sessionID: string) => Promise<string | undefined>
  /** 该 root 是否带 superagent 配置（任意 `superagent.*` 指令条目）。 */
  rootIsConfigured: (rootID: string) => Promise<boolean>
  /** 读该会话最近一次 assistant 调用的输入 token 数。 */
  readTokens: (sessionID: string) => Promise<number | undefined>
  /** 按会话模型算压缩阈值；缺省 300K。读失败按默认值处理。 */
  readThreshold?: (candidate: ProbeCandidate) => Promise<number | undefined>
  /** 该 root 的协作总开关；缺省视为启用。 */
  rootIsEnabled?: (rootID: string) => Promise<boolean>
  /** 对该子会话执行原生 compact（与手动点「压缩上下文」同一操作）。 */
  compactSession: (childSessionID: string) => Promise<void>
  /** 跨实例去重：返回 false 表示已经压缩过（且长度未下降 ≥30%）。 */
  claim?: (sessionID: string, tokens: number) => boolean
  log: (record: Record<string, unknown>) => void
  now?: () => number
}

/**
 * 超长上下文自动压缩扫描器。每个子会话只压缩一次；长度下降 ≥30% 后清声明、允许再次压缩。
 * 失败一律只记日志：读不到长度或压缩失败都不影响会话本身。
 */
export function createCtxCompactionScanner(deps: CtxCompactionScannerDeps) {
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
      let compacted = 0
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
        // compact 已生效：清掉声明，允许当前这轮重新压缩。
        if (dropped) clearContextClaim(candidate.id)
        if (!isContextOverLimit(tokens, threshold)) continue
        if (claimed !== undefined && !dropped) continue

        const claim = deps.claim ?? claimContextCompaction
        if (!claim(candidate.id, tokens)) continue
        try {
          await deps.compactSession(candidate.id)
          compacted++
          deps.log({
            event: "ctx-compact",
            decision: "allow",
            childSessionID: candidate.id,
            tokens,
            threshold,
            root: rootID,
          })
        } catch (cause) {
          // 先声明再压缩：压缩失败也不在下一轮重复轰炸同一个会话。
          deps.log({
            event: "ctx-compact-failed",
            decision: "error",
            childSessionID: candidate.id,
            tokens,
            threshold,
            root: rootID,
            cause: errorText(cause),
          })
        }
      }
      return compacted
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
 * 从插件 ctx 建出超长上下文自动压缩扫描器（真实接线）。抽出来让集成测试能用假的 ctx 驱动。
 */
export function createCtxContextCompactionScanner(
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
  return createCtxCompactionScanner({
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
    compactSession: async (childSessionID) => {
      await ctx.session.compact({ sessionID: childSessionID })
    },
    claim: options.claim ?? claimContextCompaction,
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
