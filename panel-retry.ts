/**
 * 面板失败与原生重试状态：只读 assistant 消息中的结构化 error、retry.at 与 retry.attempt。
 * 上游为 OpenCode 会话消息，下游为 panel-rows；不解析提示词、不触发续跑或模型调用。
 */

export type RetryMessage = {
  type?: string
  finish?: string
  outcome?: string
  time?: { created?: number; completed?: number }
  error?: unknown
  retry?: { attempt?: unknown; at?: unknown; error?: unknown }
}

export type FailureRetryPhase = "retrying" | "failed" | "recovered" | "interrupted"

export type FailureRetryView = {
  phase: FailureRetryPhase
  /** 原生调度信息中的 attempt；缺失时不猜测。 */
  attempt?: number
  /** 原生 retry.at；没有调度信息时退回失败消息的完成/创建时间。 */
  at?: number
  errorType?: string
  error: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function structuredError(value: unknown): { type?: string; message: string } {
  if (value instanceof Error) return { message: value.message || "未知错误" }
  if (isRecord(value)) {
    const type = typeof value.type === "string" && value.type.trim() ? value.type.trim() : undefined
    const message =
      typeof value.message === "string" && value.message.trim()
        ? value.message.trim()
        : type ?? "未知错误"
    return { type, message }
  }
  if (typeof value === "string" && value.trim()) return { message: value.trim() }
  return { message: "未知错误" }
}

function isFailure(message: RetryMessage): boolean {
  if (message.type !== "assistant") return false
  // 用户取消产生的 aborted 是执行结果，不覆盖前一次真正的 provider 失败历史。
  if (isRecord(message.error) && message.error.type === "aborted" && !message.retry) return false
  return message.finish === "error" || Boolean(message.error) || Boolean(message.retry)
}

function successful(message: RetryMessage): boolean {
  if (message.type === "idle") return message.outcome === "succeeded"
  return (
    message.type === "assistant" &&
    (message.finish === "stop" || message.finish === "tool-calls" || message.finish === "length")
  )
}

/**
 * 从时间升序的会话消息还原最近一次失败及其原生重试状态。
 * 只有 retry 标记且会话仍活跃时才显示“正在重试”；成功/取消后保留失败原因。
 */
export function failureRetryView(
  messages: ReadonlyArray<RetryMessage> | undefined,
  session: { running: boolean; outcome?: string },
): FailureRetryView | undefined {
  if (!messages) return undefined
  let failureIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isFailure(messages[index]!)) {
      failureIndex = index
      break
    }
  }
  if (failureIndex < 0) return undefined

  const failure = messages[failureIndex]!
  const retry = failure.retry
  const detail = structuredError(retry?.error ?? failure.error)
  const rawAttempt = retry?.attempt
  const attempt =
    typeof rawAttempt === "number" && Number.isInteger(rawAttempt) && rawAttempt > 0 ? rawAttempt : undefined
  const at =
    finiteTime(retry?.at) ?? finiteTime(failure.time?.completed) ?? finiteTime(failure.time?.created)
  const later = messages.slice(failureIndex + 1)
  const recovered = later.some(successful) || (!session.running && session.outcome === "succeeded")
  const interrupted =
    !session.running &&
    (session.outcome === "interrupted" || later.some((message) => message.type === "idle" && message.outcome === "interrupted"))
  const phase: FailureRetryPhase = recovered
    ? "recovered"
    : interrupted
      ? "interrupted"
      : session.running && retry
        ? "retrying"
        : "failed"
  return { phase, attempt, at, errorType: detail.type, error: detail.message }
}

function clock(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 面板独立状态行；错误原因另起一行，避免长 provider 文案吞掉重试状态。 */
export function formatFailureRetryStatus(view: FailureRetryView): string {
  const attempt = view.attempt === undefined ? "" : ` #${view.attempt}`
  const at = view.at === undefined ? "" : ` · ${clock(view.at)}`
  const status =
    view.phase === "retrying"
      ? `正在重试${attempt}`
      : view.phase === "recovered"
        ? `已恢复${attempt ? ` · 重试${attempt}` : ""}`
        : view.phase === "interrupted"
          ? `已中断 · 重试已停止${attempt ? ` #${view.attempt}` : ""}`
          : `失败${attempt ? ` · 重试${attempt}` : ""}`
  return `${status}${at}`
}
