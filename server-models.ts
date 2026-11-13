/**
 * Server 的模型与限额判定：模型引用、限额类错误、fallback 配置、限额降档
 * 与限额备用模型状态机。这里只做纯判定；远端读写由调用方注入。
 */

import { isCriticSession } from "./critic"
import { DEFAULT_OVERSIGHT_LEVEL } from "./oversight"
import {
  CRITIC_ENABLED_KEY,
  DEFAULT_FALLBACK_THRESHOLD,
  DEFAULT_MAX_SUBAGENTS,
  FALLBACK_ENABLED_KEY,
  FALLBACK_MODEL_KEY,
  FALLBACK_RETRY_DELAY_MS,
  FALLBACK_THRESHOLD_KEY,
  MAX_SUBAGENTS_KEY,
  OVERSIGHT_LEVEL_KEY,
  QUOTA_LIMIT_FLOOR,
  QUOTA_TIER_DOWN,
  SUBAGENT_FALLBACK_MODEL_KEY,
  asArray,
  errorText,
  isObject,
} from "./server-state"

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
  /** 计时窗口（毫秒）：窗口内没恢复就切备用模型。 */
  timeoutMs?: number
  /** 到点时的切换尝试次数上限（含首次）。 */
  maxSwitchAttempts?: number
  /** 到点时是否允许切换（协作开关、保护名单）；返回 false 就不切。 */
  canSwitch?: (input: { sessionID: string; rootID: string }) => Promise<boolean>
  /** 到点时重读配置条目；读失败回退首次快照。 */
  readEntries?: (input: { sessionID: string; rootID: string }) => Promise<any[]>
}

/** 首次限额失败开始计时的窗口（毫秒）：窗口内没恢复就切备用模型。 */
export const FALLBACK_TIMEOUT_MS = 60_000
/** 到点切换的尝试次数上限（含首次）：失败后再试一次，仍失败就放弃。 */
export const FALLBACK_MAX_SWITCH_ATTEMPTS = 2

/** 一个会话正在计时的限额备用切换。 */
type PendingFallback = {
  /** 首次失败时的快照：会话、根、模型与配置条目。 */
  input: RetryFailure
  /** 已发起的切换尝试次数。 */
  attempts: number
  /** 开始计时的时刻。 */
  armedAt: number
  /** 最近一次累计到的失败次数。 */
  failures: number
  /** 最近一次失败的重试次数（宿主侧 attempt）。 */
  lastAttempt?: number
  /** 正在切换：避免定时器与同步到期路径同时切。 */
  switching?: boolean
  timer?: ReturnType<typeof setTimeout>
}

/**
 * 限额备用模型状态机：首次限额失败开始计时，窗口内任一成功恢复就取消，
 * 窗口到期仍未恢复才切一次模型，并把 root 的 max-subagents 降一档。
 * 远端读写在调用方完成，这里只做判定与状态。
 */
export function createQuotaFallback(deps: QuotaFallbackDeps) {
  const failures = new Map<string, number>()
  const switched = new Set<string>()
  /** 正在计时的会话：每个会话最多一条。 */
  const pending = new Map<string, PendingFallback>()
  const now = deps.now ?? Date.now
  const tierDown = deps.tierDown ?? QUOTA_TIER_DOWN
  const timeoutMs = deps.timeoutMs ?? FALLBACK_TIMEOUT_MS
  const maxSwitchAttempts = deps.maxSwitchAttempts ?? FALLBACK_MAX_SWITCH_ATTEMPTS
  /** 插件已卸载：dispose 之后不再切模型。 */
  let disposed = false

  /** 取消计时并丢掉待办（保留「已切过」标记）。 */
  const clearPending = (sessionID: string) => {
    const entry = pending.get(sessionID)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    pending.delete(sessionID)
  }

  /** 启动（或重启）计时：只负责定时器本身。dispose 之后不再起计时。 */
  const arm = (sessionID: string, entry: PendingFallback) => {
    if (disposed) return
    const timer = setTimeout(() => {
      void runTimeout(sessionID, entry).catch((cause) =>
        deps.log({
          event: "fallback-timeout-failed",
          decision: "error",
          sessionID,
          root: entry.input.rootID,
          cause: errorText(cause),
        }),
      )
    }, timeoutMs)
    ;(timer as any)?.unref?.()
    entry.timer = timer
    pending.set(sessionID, entry)
  }

  /** 切换成功后把 root 的上限降一档。 */
  const tierDownLimit = async (input: {
    rootID: string
    entries: any[]
    failures: number
  }) => {
    const current = readMaxSubagents(input.entries)
    const next = downgradeLimit(current)
    if (next === undefined) {
      deps.log({ event: "quota-tier-down-skip", decision: "allow", root: input.rootID, limit: current })
      return
    }
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
      deps.log({
        event: "quota-tier-down-failed",
        decision: "error",
        root: input.rootID,
        from: current,
        to: next,
        cause: errorText(cause),
      })
    }
  }

  /** 到点处理：判重、读最新配置、切模型。失败最多再试一次。 */
  const runTimeout = async (
    sessionID: string,
    entry: PendingFallback,
  ): Promise<{ switched: boolean; to?: ModelRef }> => {
    // 插件已卸载：不再切模型。
    if (disposed) return { switched: false }
    // 计时已被取消或换人：不处理。
    if (pending.get(sessionID) !== entry) return { switched: false }
    // 已经在切：定时器与同步到期路径不重复切。
    if (entry.switching) return { switched: false }
    entry.switching = true
    try {
      return await switchOnTimeout(sessionID, entry)
    } finally {
      entry.switching = false
    }
  }

  /** 计时是否仍然有效：pending 被 reset/cancel/dispose 清掉就作废。 */
  const stillArmed = (sessionID: string, entry: PendingFallback) =>
    !disposed && pending.get(sessionID) === entry

  /** 到点切换的主体：判重、读最新配置、切模型。 */
  const switchOnTimeout = async (
    sessionID: string,
    entry: PendingFallback,
  ): Promise<{ switched: boolean; to?: ModelRef }> => {
    // 插件已卸载或计时已被取消：不处理。
    if (!stillArmed(sessionID, entry)) return { switched: false }
    const snapshot = entry.input
    const base = {
      sessionID,
      root: snapshot.rootID,
      failures: entry.failures,
      attempt: snapshot.attempt,
    }
    if (switched.has(sessionID)) {
      clearPending(sessionID)
      return { switched: false }
    }
    if (deps.canSwitch) {
      let allowed = true
      try {
        allowed = await deps.canSwitch({ sessionID, rootID: snapshot.rootID })
      } catch (cause) {
        allowed = false
        deps.log({
          event: "fallback-timeout-check-failed",
          decision: "error",
          ...base,
          cause: errorText(cause),
        })
      }
      // 等待期间可能已被 reset/cancel/dispose 作废：不再切。
      if (!stillArmed(sessionID, entry)) return { switched: false }
      if (!allowed) {
        deps.log({
          event: "fallback-timeout-skip",
          decision: "allow",
          ...base,
          note: "协作停用或会话受保护：不切模型",
        })
        clearPending(sessionID)
        failures.set(sessionID, 0)
        return { switched: false }
      }
    }
    let entries = snapshot.entries
    if (deps.readEntries) {
      try {
        entries = await deps.readEntries({ sessionID, rootID: snapshot.rootID })
      } catch (cause) {
        entries = snapshot.entries
        deps.log({
          event: "fallback-entries-read-failed",
          decision: "error",
          ...base,
          note: "读取最新配置失败，沿用首次快照",
          cause: errorText(cause),
        })
      }
      // 等待期间可能已被 reset/cancel/dispose 作废：不再切。
      if (!stillArmed(sessionID, entry)) return { switched: false }
    }
    const config = readFallbackConfig(entries)
    if (!config.enabled) {
      deps.log({ event: "fallback-disabled", decision: "allow", ...base, phase: "timeout" })
      clearPending(sessionID)
      failures.set(sessionID, 0)
      return { switched: false }
    }
    const target = snapshot.isRoot ? config.rootModel : config.subModel
    if (!target) {
      deps.log({
        event: "fallback-unconfigured",
        decision: "allow",
        ...base,
        phase: "timeout",
        kind: snapshot.isRoot ? "root" : "subagent",
      })
      clearPending(sessionID)
      failures.set(sessionID, 0)
      return { switched: false }
    }
    const from = formatModelRef(snapshot.model)
    const to = formatModelRef(target)
    if (from && to && from === to) {
      // 已经在备用模型上：不再切，标记已切避免反复触发。
      deps.log({ event: "fallback-same-model", decision: "allow", ...base, from, to })
      switched.add(sessionID)
      clearPending(sessionID)
      failures.set(sessionID, 0)
      return { switched: false }
    }
    const attempt = entry.attempts + 1
    // 切之前最后一次确认：计时可能已被 reset/cancel/dispose 作废。
    if (!stillArmed(sessionID, entry)) return { switched: false }
    try {
      await deps.switchModel({ sessionID, model: target })
    } catch (cause) {
      deps.log({
        event: "fallback-switch-failed",
        decision: "error",
        ...base,
        from,
        to,
        attempts: attempt,
        cause: errorText(cause),
      })
      // 切换期间可能已被 reset/cancel/dispose 作废：不再重试计时。
      if (!stillArmed(sessionID, entry)) {
        clearPending(sessionID)
        return { switched: false }
      }
      if (attempt < maxSwitchAttempts) {
        entry.attempts = attempt
        arm(sessionID, entry)
        deps.log({
          event: "fallback-retry-armed",
          decision: "allow",
          ...base,
          attempts: attempt,
          timeoutMs,
        })
      } else {
        deps.log({
          event: "fallback-timeout-giveup",
          decision: "allow",
          ...base,
          attempts: attempt,
          note: "切换尝试次数用尽，等下一次新的限额失败",
        })
        clearPending(sessionID)
        failures.set(sessionID, 0)
      }
      return { switched: false }
    }
    switched.add(sessionID)
    failures.set(sessionID, 0)
    clearPending(sessionID)
    deps.log({
      event: "fallback-model-switch",
      decision: "allow",
      ...base,
      from,
      to,
      reason: "timeout",
      attempts: attempt,
      waitedMs: now() - entry.armedAt,
      at: new Date(now()).toISOString(),
    })
    if (tierDown) {
      await tierDownLimit({ rootID: snapshot.rootID, entries, failures: entry.failures })
    }
    return { switched: true, to: target }
  }

  return {
    failuresOf(sessionID: string) {
      return failures.get(sessionID) ?? 0
    },
    hasSwitched(sessionID: string) {
      return switched.has(sessionID)
    },
    /** 是否正在计时（测试与排查用）。 */
    isArmed(sessionID: string) {
      return pending.has(sessionID)
    },
    /** 任一 LLM 成功：取消计时并清零失败，但保留「已切过」标记。 */
    reset(sessionID: string) {
      clearPending(sessionID)
      failures.delete(sessionID)
    },
    /** 放弃这次计时（中断、非限额失败、会话删除）：不切模型。 */
    cancel(sessionID: string) {
      clearPending(sessionID)
      failures.set(sessionID, 0)
    },
    /** 停掉所有计时（插件卸载时调用）：dispose 之后到点的切换也不再执行。 */
    dispose() {
      disposed = true
      for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer)
      }
      pending.clear()
    },
    async onFailure(input: RetryFailure): Promise<{ switched: boolean; to?: ModelRef }> {
      if (disposed) return { switched: false }
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

      const existing = pending.get(input.sessionID)
      if (existing) {
        // 已经在计时：只更新快照，不重复计时、不切换。
        existing.failures = count
        existing.lastAttempt = input.attempt ?? existing.lastAttempt
        existing.input = { ...existing.input, ...input, entries: input.entries ?? existing.input.entries }
        // 计时已到期但回调还没排到：当场同步走一次到期逻辑。
        if (now() - existing.armedAt >= timeoutMs) {
          if (existing.timer) clearTimeout(existing.timer)
          return runTimeout(input.sessionID, existing)
        }
        return { switched: false }
      }

      const entry: PendingFallback = {
        input: { ...input },
        attempts: 0,
        armedAt: now(),
        failures: count,
        lastAttempt: input.attempt,
      }
      arm(input.sessionID, entry)
      deps.log({
        event: "fallback-armed",
        decision: "allow",
        ...base,
        timeoutMs,
        deadline: new Date(entry.armedAt + timeoutMs).toISOString(),
      })
      return { switched: false }
    },
  }
}
