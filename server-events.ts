/**
 * Server 事件订阅与串行处理。
 *
 * 上游是 server.ts 注入的宿主订阅与已绑定业务依赖；下游驱动状态看护、
 * 模型委派/旗舰标记、限额备用切换与 critic 复核。订阅异常或正常结束后
 * 在同一后台任务内退避重连，abort 后不再订阅。
 */

import { isQuotaFailure } from "./server-models"
import { eventData } from "./server-session"
import { errorText, eventSessionID, isObject } from "./server-state"
import type { CompletionState, SettleOptions, StatusWatcher } from "./subagent-status"
import { SHELL_SETTLE_DELAY_MS } from "./subagent-status"

export const SERVER_EVENT_TYPES = [
  "session.created",
  "session.step.ended",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.shell.started",
  "session.shell.ended",
  "session.model.selected",
  "session.deleted",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
] as const

export const EVENT_SUBSCRIPTION_INITIAL_DELAY_MS = 250
export const EVENT_SUBSCRIPTION_MAX_DELAY_MS = 5000

export type ServerEventSubscribeOptions = {
  types: readonly string[]
  signal: AbortSignal
}

/** 事件循环只依赖已绑定能力，不持有宿主 ctx，也不另建业务状态。 */
export type ServerEventDeps = {
  signal: AbortSignal
  subscribe: (options: ServerEventSubscribeOptions) => AsyncIterable<any>
  watcher: Pick<StatusWatcher, "settle" | "observeNativeNotice" | "observeNativeDelivery" | "observeNativeCancel">
  quotaFallback: {
    reset: (sessionID: string) => void
    cancel: (sessionID: string) => void
    forget: (sessionID: string) => void
  }
  markDelegationOnSessionCreated: (event: any) => Promise<void>
  handleSessionModelSelected: (event: any) => Promise<void>
  reviewAfterSuccess: (sessionID: string, claimID?: string) => Promise<void> | void
  triggerQuotaFallback: (sessionID: string, error: unknown, model?: unknown) => Promise<unknown>
  readSessionModel: (sessionID: string) => Promise<unknown>
  log: (record: Record<string, unknown>) => void
  initialDelayMs?: number
  maxDelayMs?: number
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
}

function restartDelay(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 等待期间 abort 必须同时清定时器和监听器，并明确告知循环不要重连。 */
function waitForRestart(deps: ServerEventDeps, delayMs: number): Promise<boolean> {
  const { signal } = deps
  if (signal.aborted) return Promise.resolve(false)
  const schedule = deps.setTimeout ?? globalThis.setTimeout
  const cancel = deps.clearTimeout ?? globalThis.clearTimeout
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (restart: boolean) => {
      if (settled) return
      settled = true
      if (!restart && timer !== undefined) cancel(timer)
      signal.removeEventListener("abort", onAbort)
      resolve(restart)
    }
    const onAbort = () => finish(false)
    signal.addEventListener("abort", onAbort, { once: true })
    timer = schedule(() => finish(true), delayMs)
    ;(timer as any)?.unref?.()
    if (signal.aborted) onAbort()
  })
}

function settle(watcher: Pick<StatusWatcher, "settle">, sessionID: string, options?: SettleOptions) {
  watcher.settle(sessionID, options)
}

/** core InboxEnqueued：入队时间在 event.created，通知字段在 data.item.payload。 */
function observeNativeInboxNotice(event: any, deps: ServerEventDeps): boolean {
  const data = eventData(event)
  const item = data.item
  if (!isObject(item) || item.type !== "synthetic" || !isObject(item.payload)) return false
  const payload = item.payload
  const metadata = isObject(payload.metadata) ? payload.metadata : undefined
  if (metadata?.source !== "subagent") return false
  const childID = typeof metadata.childID === "string" && metadata.childID ? metadata.childID : undefined
  const state = typeof metadata.state === "string" && metadata.state ? metadata.state : undefined
  const text = typeof payload.text === "string" ? payload.text : undefined
  const time = typeof event?.created === "number" && Number.isFinite(event.created) ? event.created : undefined
  const inboxID = typeof data.inboxID === "string" && data.inboxID ? data.inboxID : undefined
  if (!childID || !state || text === undefined || time === undefined) return false
  return deps.watcher.observeNativeNotice({ childID, state, text, time, inboxID })
}

/**
 * core InboxDelivered / InboxCancelled：data 只带 sessionID 与 inboxID，
 * 时间取 event.created；字段缺失或无命中 fail-open，不影响其他事件。
 */
function observeNativeInboxDelivery(event: any, deps: ServerEventDeps, cancelled: boolean): boolean {
  const data = eventData(event)
  const inboxID = typeof data.inboxID === "string" && data.inboxID ? data.inboxID : undefined
  if (!inboxID) return false
  const time = typeof event?.created === "number" && Number.isFinite(event.created) ? event.created : undefined
  return cancelled
    ? deps.watcher.observeNativeCancel({ inboxID, time })
    : deps.watcher.observeNativeDelivery({ inboxID, time })
}

/** 保持原有逐事件分支顺序；每次迭代 await 完处理后才取下一条事件。 */
async function handleServerEvent(event: any, deps: ServerEventDeps) {
  if (event?.type === "session.inbox.enqueued") {
    observeNativeInboxNotice(event, deps)
    return
  }
  if (event?.type === "session.inbox.delivered") {
    observeNativeInboxDelivery(event, deps, false)
    return
  }
  if (event?.type === "session.inbox.cancelled") {
    observeNativeInboxDelivery(event, deps, true)
    return
  }
  if (event?.type === "session.created") {
    try {
      await deps.markDelegationOnSessionCreated(event)
    } catch (cause) {
      deps.log({
        event: "model-delegation-mark-failed",
        decision: "error",
        phase: "created",
        type: event.type,
        childSessionID: eventSessionID(event),
        cause: errorText(cause),
      })
    }
    return
  }
  if (event?.type === "session.model.selected") {
    try {
      await deps.handleSessionModelSelected(event)
    } catch (cause) {
      deps.log({
        event: "flagship-marker-failed",
        decision: "error",
        type: event.type,
        childSessionID: eventSessionID(event),
        cause: errorText(cause),
      })
    }
    return
  }

  // 状态回传：子会话结束与 shell 起止只驱动看护项，不参与限额计时。
  const watchedID = eventSessionID(event)
  if (
    watchedID &&
    (event?.type === "session.execution.succeeded" ||
      event?.type === "session.execution.failed" ||
      event?.type === "session.execution.interrupted" ||
      event?.type === "session.shell.started" ||
      event?.type === "session.shell.ended")
  ) {
    if (event.type === "session.shell.ended") {
      settle(deps.watcher, watchedID, { delayMs: SHELL_SETTLE_DELAY_MS })
    } else if (event.type === "session.shell.started") {
      settle(deps.watcher, watchedID)
    } else {
      const state: CompletionState =
        event.type === "session.execution.failed"
          ? "error"
          : event.type === "session.execution.interrupted"
            ? "cancelled"
            : "completed"
      settle(deps.watcher, watchedID, { state })
    }
  }

  const sessionID = eventSessionID(event)
  if (!sessionID) return
  // 限额备用：成功即取消计时；中断与会话删除放弃计时；
  // 限额失败保留计时（窗口内没恢复才切）；其他失败同样放弃。
  if (event?.type === "session.execution.succeeded") {
    deps.quotaFallback.reset(sessionID)
  } else if (event?.type === "session.step.ended") {
    // 只有 error 表示步骤失败：其余取值以及缺省都说明模型已返回，即已恢复。
    const finish = eventData(event)?.finish
    if (finish !== "error") deps.quotaFallback.reset(sessionID)
  } else if (event?.type === "session.execution.interrupted") {
    deps.quotaFallback.cancel(sessionID)
  } else if (event?.type === "session.deleted") {
    deps.quotaFallback.forget(sessionID)
  } else if (event?.type === "session.execution.failed") {
    const failure = eventData(event)?.error
    if (isQuotaFailure(failure)) {
      // 宿主可能没触发 retry 钩子：失败事件走同一条限额备用路径。
      let model: unknown
      try {
        model = await deps.readSessionModel(sessionID)
      } catch {
        model = undefined
      }
      try {
        await deps.triggerQuotaFallback(sessionID, failure, model)
      } catch (cause) {
        deps.log({
          event: "fallback-hook-error",
          decision: "error",
          phase: "execution-failed",
          root: null,
          count: null,
          limit: null,
          sessionID,
          cause: errorText(cause),
        })
      }
    } else {
      deps.quotaFallback.cancel(sessionID)
    }
  }
  // 复核在内部按该会话所属 root 的开关短路，保持后台执行。
  if (event?.type === "session.execution.succeeded") {
    void deps.reviewAfterSuccess(sessionID, event?.id)
  }
}

/**
 * 启动唯一事件消费循环。任何订阅异常都在内部处理；返回的 Promise 由
 * server.ts 强引用，正常结束与异常结束使用同一可 abort 的退避等待。
 */
export async function startServerEventSubscription(deps: ServerEventDeps): Promise<void> {
  const initialDelay = restartDelay(deps.initialDelayMs, EVENT_SUBSCRIPTION_INITIAL_DELAY_MS)
  const maxDelay = Math.max(initialDelay, restartDelay(deps.maxDelayMs, EVENT_SUBSCRIPTION_MAX_DELAY_MS))
  let delay = initialDelay
  while (!deps.signal.aborted) {
    let reason: string
    try {
      for await (const event of deps.subscribe({ types: SERVER_EVENT_TYPES, signal: deps.signal })) {
        // 收到事件说明本轮连接有效；其后若断开，从初始退避重新开始。
        delay = initialDelay
        await handleServerEvent(event, deps)
      }
      if (deps.signal.aborted) return
      reason = "stream-ended"
    } catch (cause) {
      if (deps.signal.aborted) return
      reason = errorText(cause)
    }
    deps.log({ event: "event-subscription-restart", decision: "allow", reason, delay })
    if (!(await waitForRestart(deps, delay))) return
    delay = Math.min(maxDelay, Math.max(initialDelay, delay * 2))
  }
}
