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
