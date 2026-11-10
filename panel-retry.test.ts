import { describe, expect, test } from "bun:test"
import { failureRetryView, formatFailureRetryStatus, type RetryMessage } from "./panel-retry"

const failure = (input?: {
  id?: string
  created?: number
  completed?: number
  message?: string
  attempt?: number
  at?: number
  retry?: boolean
}): RetryMessage => {
  const error = { type: "provider.unknown", message: input?.message ?? "provider timed out" }
  const withRetry = input?.retry ?? true
  return {
    type: "assistant",
    finish: "error",
    time: { created: input?.created ?? 100, completed: input?.completed ?? 200 },
    error,
    retry: withRetry ? { attempt: input?.attempt ?? 2, at: input?.at ?? 300, error } : undefined,
  }
}

const success = (created = 400): RetryMessage => ({
  type: "assistant",
  finish: "stop",
  time: { created, completed: created + 50 },
})

describe("failureRetryView", () => {
  test("没有失败消息时不占面板行", () => {
    expect(failureRetryView([success()], { running: false, outcome: "succeeded" })).toBeUndefined()
    expect(failureRetryView([], { running: false })).toBeUndefined()
  })

  test("真实 Qoder 超时字段：失败后新 assistant 仍在跑，显示原生第 2 次重试", () => {
    const timedOut = failure({
      created: 1_794_279_579_550,
      completed: 1_794_281_328_754,
      message: "Qoder CLI call timed out after 1800000 ms.",
      attempt: 2,
      at: 1_794_281_331_020,
    })
    const nextAssistant: RetryMessage = { type: "assistant", time: { created: 1_794_281_331_044 } }
    const view = failureRetryView([timedOut, nextAssistant], { running: true })
    expect(view).toMatchObject({
      phase: "retrying",
      attempt: 2,
      at: 1_794_281_331_020,
      errorType: "provider.unknown",
      error: "Qoder CLI call timed out after 1800000 ms.",
    })
    expect(formatFailureRetryStatus(view!)).toContain("正在重试 #2")
  })

  test("超时失败→重试→成功：恢复后仍保留上次失败原因和 attempt", () => {
    const view = failureRetryView(
      [failure({ message: "timed out", attempt: 2 }), success(), { type: "idle", outcome: "succeeded", time: { created: 500 } }],
      { running: false, outcome: "succeeded" },
    )
    expect(view).toMatchObject({ phase: "recovered", attempt: 2, error: "timed out" })
    expect(formatFailureRetryStatus(view!)).toContain("已恢复 · 重试 #2")
  })

  test("连续失败：展示最近一次真实 error 和最新 attempt，不累计猜测", () => {
    const view = failureRetryView(
      [
        failure({ created: 100, message: "first timeout", attempt: 2, at: 200 }),
        failure({ created: 300, message: "second timeout", attempt: 3, at: 400 }),
      ],
      { running: true },
    )
    expect(view).toMatchObject({ phase: "retrying", attempt: 3, at: 400, error: "second timeout" })
  })

  test("连续失败后最终失败：活跃标记消失后不伪称重试中", () => {
    const view = failureRetryView(
      [failure({ message: "first", attempt: 2 }), failure({ created: 300, message: "last", attempt: 3 })],
      { running: false, outcome: "failed" },
    )
    expect(view).toMatchObject({ phase: "failed", attempt: 3, error: "last" })
    expect(formatFailureRetryStatus(view!)).not.toContain("正在重试")
  })

  test("取消后不再显示重试中，并不以 aborted 覆盖 provider 失败原因", () => {
    const view = failureRetryView(
      [
        failure({ message: "cancel me", attempt: 2 }),
        {
          type: "assistant",
          finish: "error",
          error: { type: "aborted", message: "Step interrupted" },
          time: { created: 400, completed: 500 },
        },
      ],
      { running: false, outcome: "interrupted" },
    )
    expect(view).toMatchObject({ phase: "interrupted", attempt: 2, error: "cancel me" })
    const status = formatFailureRetryStatus(view!)
    expect(status).toContain("重试已停止")
    expect(status).not.toContain("正在重试")
  })

  test("取消后的旧 outcome 与活跃执行冲突时，以真实 running 为准", () => {
    const view = failureRetryView([failure()], { running: true, outcome: "interrupted" })
    expect(view?.phase).toBe("retrying")
  })

  test("没有 retry 标记的失败即使后续活跃也不伪造成自动重试", () => {
    const view = failureRetryView([failure({ retry: false }), { type: "assistant", time: { created: 300 } }], {
      running: true,
    })
    expect(view).toMatchObject({ phase: "failed", attempt: undefined })
  })

  test("后续 finish=unknown 不伪造成已恢复", () => {
    const view = failureRetryView(
      [failure(), { type: "assistant", finish: "unknown", time: { created: 400, completed: 450 } }],
      { running: false },
    )
    expect(view?.phase).toBe("failed")
  })

  test("结构化错误缺 message 时只用 type，不序列化整个响应", () => {
    const message: RetryMessage = {
      type: "assistant",
      finish: "error",
      error: { type: "provider.timeout", response: { body: "secret-body" } },
      time: { created: 100 },
    }
    const view = failureRetryView([message], { running: false, outcome: "failed" })
    expect(view).toMatchObject({ errorType: "provider.timeout", error: "provider.timeout" })
    expect(JSON.stringify(view)).not.toContain("secret-body")
  })
})
