/**
 * server-events 纯逻辑测试：九类事件分支、串行顺序、断流重连、
 * 指数退避与 abort 清理；不依赖真实插件宿主。
 */
import { describe, expect, test } from "bun:test"

import {
  EVENT_SUBSCRIPTION_INITIAL_DELAY_MS,
  EVENT_SUBSCRIPTION_MAX_DELAY_MS,
  SERVER_EVENT_TYPES,
  startServerEventSubscription,
  type ServerEventDeps,
} from "./server-events"
import { SHELL_SETTLE_DELAY_MS } from "./subagent-status"

function event(type: string, sessionID = "ses_child", data: Record<string, unknown> = {}) {
  return { id: `evt_${type}_${sessionID}`, type, data: { sessionID, ...data } }
}

function inboxEvent(options: Record<string, unknown> = {}) {
  const childID = "childID" in options ? options.childID : "ses_child"
  const state = "state" in options ? options.state : "completed"
  const metadata = "metadata" in options
    ? options.metadata
    : { source: "source" in options ? options.source : "subagent", childID, state }
  return {
    id: options.id ?? "evt_inbox",
    type: "session.inbox.enqueued",
    created: "created" in options ? options.created : 1_800_000_000_123,
    data: {
      sessionID: "ses_parent",
      inboxID: "inboxID" in options ? options.inboxID : "msg_inbox",
      item: {
        type: options.itemType ?? "synthetic",
        delivery: "queue",
        payload: {
          text: "text" in options ? options.text : `<subagent sessionID="ses_child" state="${String(state)}">done</subagent>`,
          metadata,
        },
      },
    },
  }
}

function inboxLifecycleEvent(type: "session.inbox.delivered" | "session.inbox.cancelled", options: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { sessionID: "ses_parent" }
  if ("inboxID" in options) data.inboxID = options.inboxID
  return {
    id: options.id ?? `evt_${type}`,
    type,
    created: "created" in options ? options.created : 1_800_000_000_456,
    data,
  }
}

function waitUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

function eventSource(signal: AbortSignal, events: any[] = []): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of events) yield item
      await waitUntilAborted(signal)
    },
  }
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

async function waitFor(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return check()
}

function fakeClock() {
  let nextID = 1
  const pending: Array<{ id: number; delay: number; callback: () => void }> = []
  const cleared: number[] = []
  return {
    pending,
    cleared,
    setTimeout(callback: () => void, delay: number) {
      const id = nextID++
      pending.push({ id, delay, callback })
      return { id, unref() {} } as any
    },
    clearTimeout(timer: any) {
      cleared.push(timer.id)
      const index = pending.findIndex((item) => item.id === timer.id)
      if (index >= 0) pending.splice(index, 1)
    },
    async runNext() {
      const timer = pending.shift()
      if (!timer) throw new Error("没有待执行的退避定时器")
      timer.callback()
      await flush()
    },
  }
}

function harness(
  subscribe: ServerEventDeps["subscribe"],
  overrides: Partial<ServerEventDeps> = {},
) {
  const controller = new AbortController()
  const actions: string[] = []
  const logs: Record<string, unknown>[] = []
  const settles: Array<{ sessionID: string; options?: any }> = []
  const resets: string[] = []
  const cancels: string[] = []
  const forgets: string[] = []
  const reviews: Array<{ sessionID: string; claimID?: string }> = []
  const nativeNotices: Array<{ childID: string; state: string; text?: string; time?: number | string | Date; inboxID?: string }> = []
  let nativeNoticeResult = true
  const inboxDeliveries: Array<{ inboxID: string; time?: number }> = []
  const inboxCancels: Array<{ inboxID: string; time?: number }> = []
  let inboxResult = true
  const fallbacks: Array<{ sessionID: string; error: unknown; model?: unknown }> = []
  const deps: ServerEventDeps = {
    signal: controller.signal,
    subscribe,
    watcher: {
      settle(sessionID, options) {
        settles.push({ sessionID, options })
        actions.push(`settle:${sessionID}:${options?.state ?? options?.delayMs ?? "none"}`)
      },
      observeNativeNotice(input) {
        nativeNotices.push(input)
        actions.push(`native:${input.childID}:${input.state}`)
        return nativeNoticeResult
      },
      observeNativeDelivery(input) {
        inboxDeliveries.push(input)
        actions.push(`delivered:${input.inboxID}`)
        return inboxResult
      },
      observeNativeCancel(input) {
        inboxCancels.push(input)
        actions.push(`cancelled:${input.inboxID}`)
        return inboxResult
      },
    },
    quotaFallback: {
      reset(sessionID) {
        resets.push(sessionID)
        actions.push(`reset:${sessionID}`)
      },
      cancel(sessionID) {
        cancels.push(sessionID)
        actions.push(`cancel:${sessionID}`)
      },
      forget(sessionID) {
        forgets.push(sessionID)
        actions.push(`forget:${sessionID}`)
      },
    },
    async markDelegationOnSessionCreated(item) {
      actions.push(`created:${item.data.sessionID}`)
    },
    async handleSessionModelSelected(item) {
      actions.push(`selected:${item.data.sessionID}`)
    },
    reviewAfterSuccess(sessionID, claimID) {
      reviews.push({ sessionID, claimID })
      actions.push(`review:${sessionID}`)
    },
    async triggerQuotaFallback(sessionID, error, model) {
      fallbacks.push({ sessionID, error, model })
      actions.push(`fallback:${sessionID}`)
    },
    async readSessionModel(sessionID) {
      actions.push(`model:${sessionID}`)
      return { providerID: "acme", id: "old" }
    },
    log(record) {
      logs.push(record)
    },
    ...overrides,
  }
  return {
    controller,
    deps,
    actions,
    logs,
    settles,
    resets,
    cancels,
    forgets,
    reviews,
    nativeNotices,
    setNativeNoticeResult(value: boolean) {
      nativeNoticeResult = value
    },
    inboxDeliveries,
    inboxCancels,
    setInboxResult(value: boolean) {
      inboxResult = value
    },
    fallbacks,
  }
}

describe("server 事件语义", () => {
  test("九类事件保留 watcher、quota、委派标记、模型标记、critic 与 fallback 分支及顺序", async () => {
    const events = [
      event("session.created", "ses_created", { parentID: "ses_root", model: "acme/next" }),
      event("session.model.selected", "ses_selected"),
      event("session.shell.started"),
      event("session.shell.ended"),
      event("session.execution.succeeded", "ses_success"),
      event("session.step.ended", "ses_step_stop", { finish: "stop" }),
      event("session.step.ended", "ses_step_error", { finish: "error" }),
      event("session.step.ended", "ses_step_missing"),
      event("session.execution.failed", "ses_quota", { error: { status: 429 } }),
      event("session.execution.failed", "ses_plain", { error: new Error("bad input") }),
      event("session.execution.interrupted", "ses_cancelled"),
      event("session.deleted", "ses_deleted"),
    ]
    const h = harness((options) => eventSource(options.signal, events))
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => h.forgets.includes("ses_deleted"))).toBe(true)

    expect(h.actions).toContain("created:ses_created")
    expect(h.actions).toContain("selected:ses_selected")
    expect(h.settles).toEqual([
      { sessionID: "ses_child", options: undefined },
      { sessionID: "ses_child", options: { delayMs: SHELL_SETTLE_DELAY_MS } },
      { sessionID: "ses_success", options: { state: "completed" } },
      { sessionID: "ses_quota", options: { state: "error" } },
      { sessionID: "ses_plain", options: { state: "error" } },
      { sessionID: "ses_cancelled", options: { state: "cancelled" } },
    ])
    expect(h.resets).toEqual(["ses_success", "ses_step_stop", "ses_step_missing"])
    expect(h.cancels).toEqual(["ses_plain", "ses_cancelled"])
    expect(h.forgets).toEqual(["ses_deleted"])
    expect(h.reviews).toEqual([
      { sessionID: "ses_success", claimID: "evt_session.execution.succeeded_ses_success" },
    ])
    expect(h.fallbacks).toHaveLength(1)
    expect(h.fallbacks[0]).toEqual({
      sessionID: "ses_quota",
      error: { status: 429 },
      model: { providerID: "acme", id: "old" },
    })

    const success = ["settle:ses_success:completed", "reset:ses_success", "review:ses_success"].map(
      (action) => h.actions.indexOf(action),
    )
    expect(success).toEqual([...success].sort((a, b) => a - b))
    expect(success.every((index) => index >= 0)).toBe(true)

    h.controller.abort()
    await running
  })

  test("无标记的真实 execution.interrupted 仍统一 settle(cancelled)", async () => {
    const h = harness((options) =>
      eventSource(options.signal, [event("session.execution.interrupted", "ses_interrupted")]),
    )
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => h.cancels.includes("ses_interrupted"))).toBe(true)
    expect(h.settles).toEqual([{ sessionID: "ses_interrupted", options: { state: "cancelled" } }])
    h.controller.abort()
    await running
  })

  test("created/model.selected 的处理异常只记原日志，不中断同一条流", async () => {
    const h = harness(
      (options) =>
        eventSource(options.signal, [
          event("session.created", "ses_created"),
          event("session.model.selected", "ses_selected"),
          event("session.step.ended", "ses_after", { finish: "stop" }),
        ]),
      {
        async markDelegationOnSessionCreated() {
          throw new Error("marker failed")
        },
        async handleSessionModelSelected() {
          throw new Error("selection failed")
        },
      },
    )
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => h.resets.includes("ses_after"))).toBe(true)
    expect(h.logs.map((record) => record.event)).toEqual([
      "model-delegation-mark-failed",
      "flagship-marker-failed",
    ])
    h.controller.abort()
    await running
  })

  test("限额读取/切换失败保留原 fail-open 日志，后续事件仍按序处理", async () => {
    const h = harness(
      (options) =>
        eventSource(options.signal, [
          event("session.execution.failed", "ses_quota", { error: "quota exceeded" }),
          event("session.execution.succeeded", "ses_after"),
        ]),
      {
        async readSessionModel() {
          throw new Error("session unavailable")
        },
        async triggerQuotaFallback(sessionID, error, model) {
          h.fallbacks.push({ sessionID, error, model })
          throw new Error("fallback failed")
        },
      },
    )
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => h.reviews.some((item) => item.sessionID === "ses_after"))).toBe(true)
    expect(h.fallbacks[0]?.model).toBeUndefined()
    expect(h.logs.find((record) => record.event === "fallback-hook-error")).toMatchObject({
      phase: "execution-failed",
      sessionID: "ses_quota",
    })
    h.controller.abort()
    await running
  })

  test("前一条事件未完成时，后一条不会并发进入 quota/critic 处理", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let fallbackStarted!: () => void
    const started = new Promise<void>((resolve) => {
      fallbackStarted = resolve
    })
    const h = harness(
      (options) =>
        eventSource(options.signal, [
          event("session.execution.failed", "ses_serial", { error: { status: 429 } }),
          event("session.execution.succeeded", "ses_serial"),
        ]),
      {
        async triggerQuotaFallback() {
          fallbackStarted()
          await gate
        },
      },
    )
    const running = startServerEventSubscription(h.deps)
    await started
    expect(h.resets).toEqual([])
    expect(h.reviews).toEqual([])
    release()
    expect(await waitFor(() => h.reviews.length === 1)).toBe(true)
    expect(h.resets).toEqual(["ses_serial"])
    h.controller.abort()
    await running
  })
})

describe("原生 inbox 通知接线", () => {
  test("读取 data.item.payload，原样转发状态别名、running 正文与 event.created", async () => {
    const states = [
      "completed",
      "succeeded",
      "error",
      "failed",
      "cancelled",
      "interrupted",
      "running",
      "background-running",
    ]
    const events = states.map((state, index) => inboxEvent({
      id: `evt_${state}`,
      state,
      created: 1_800_000_001_000 + index,
      text: `body:${state}`,
    }))
    events.push(
      inboxEvent({
        id: "evt_background_text",
        state: "completed",
        created: 1_800_000_002_000,
        text: '<subagent sessionID="ses_child" state="completed">Background work still running</subagent>',
      }),
      inboxEvent({
        id: "evt_running_tag",
        state: "completed",
        created: 1_800_000_002_001,
        text: '<subagent sessionID="ses_child" state="running">仍在运行</subagent>',
      }),
    )
    const h = harness((options) => eventSource(options.signal, events))
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => h.nativeNotices.length === events.length)).toBe(true)
    expect(h.nativeNotices.map((notice) => notice.state)).toEqual([...states, "completed", "completed"])
    expect(h.nativeNotices.map((notice) => notice.time)).toEqual(events.map((item) => item.created))
    expect(h.nativeNotices.map((notice) => notice.text)).toEqual(events.map((item) => item.data.item.payload.text))
    expect(h.nativeNotices.every((notice) => notice.childID === "ses_child")).toBe(true)
    expect(h.nativeNotices.every((notice) => notice.inboxID === "msg_inbox")).toBe(true)
    expect(h.settles).toEqual([])
    h.controller.abort()
    await running
  })

  test("非 subagent 来源、非 synthetic 与缺字段事件不调用 watcher", async () => {
    const skipped = [
      inboxEvent({ source: "superagent-agents" }),
      inboxEvent({ source: "other" }),
      inboxEvent({ itemType: "user" }),
      inboxEvent({ metadata: undefined }),
      inboxEvent({ childID: "" }),
      inboxEvent({ state: "" }),
      inboxEvent({ text: undefined }),
      inboxEvent({ created: undefined }),
    ]
    const h = harness((options) => eventSource(options.signal, [
      ...skipped,
      event("session.step.ended", "ses_after", { finish: "stop" }),
    ]))
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => h.resets.includes("ses_after"))).toBe(true)
    expect(h.nativeNotices).toEqual([])
    expect(h.logs).toEqual([])
    h.controller.abort()
    await running
  })

  test("无 watch/旧轮返回 false 不阻塞后续事件，也不触发其他事件分支", async () => {
    const h = harness((options) => eventSource(options.signal, [
      inboxEvent({ state: "succeeded", created: 1_800_000_003_000 }),
      event("session.step.ended", "ses_after", { finish: "stop" }),
    ]))
    h.setNativeNoticeResult(false)
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => h.resets.includes("ses_after"))).toBe(true)
    expect(h.nativeNotices).toEqual([{
      childID: "ses_child",
      state: "succeeded",
      text: '<subagent sessionID="ses_child" state="succeeded">done</subagent>',
      time: 1_800_000_003_000,
      inboxID: "msg_inbox",
    }])
    expect(h.settles).toEqual([])
    expect(h.reviews).toEqual([])
    expect(h.logs).toEqual([])
    h.controller.abort()
    await running
  })
})

describe("原生 inbox 投递回标接线", () => {
  test("delivered 与 cancelled 按 data.inboxID 转发，时间取 event.created", async () => {
    const events = [
      inboxLifecycleEvent("session.inbox.delivered", { id: "evt_d1", inboxID: "msg_a", created: 1_800_000_010_000 }),
      inboxLifecycleEvent("session.inbox.cancelled", { id: "evt_c1", inboxID: "msg_b", created: 1_800_000_011_000 }),
      event("session.step.ended", "ses_after", { finish: "stop" }),
    ]
    const h = harness((options) => eventSource(options.signal, events))
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => h.resets.includes("ses_after"))).toBe(true)
    expect(h.inboxDeliveries).toEqual([{ inboxID: "msg_a", time: 1_800_000_010_000 }])
    expect(h.inboxCancels).toEqual([{ inboxID: "msg_b", time: 1_800_000_011_000 }])
    expect(h.settles).toEqual([])
    expect(h.nativeNotices).toEqual([])
    expect(h.logs).toEqual([])
    h.controller.abort()
    await running
  })

  test("缺 inboxID 或 created 非法时不调用 watcher，也不影响后续事件", async () => {
    const events = [
      inboxLifecycleEvent("session.inbox.delivered", { id: "evt_no_id" }),
      { id: "evt_bad_created", type: "session.inbox.cancelled", created: "not-a-number", data: { sessionID: "ses_parent", inboxID: "msg_b" } },
      event("session.step.ended", "ses_after", { finish: "stop" }),
    ]
    const h = harness((options) => eventSource(options.signal, events))
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => h.resets.includes("ses_after"))).toBe(true)
    // 缺 inboxID 跳过；created 非法仍回标（时间缺省由 watcher 按观察时刻计）。
    expect(h.inboxDeliveries).toEqual([])
    expect(h.inboxCancels).toEqual([{ inboxID: "msg_b", time: undefined }])
    expect(h.logs).toEqual([])
    h.controller.abort()
    await running
  })

  test("回标返回 false（无命中）不阻塞后续事件", async () => {
    const events = [
      inboxLifecycleEvent("session.inbox.delivered", { id: "evt_miss", inboxID: "msg_miss" }),
      inboxLifecycleEvent("session.inbox.cancelled", { id: "evt_miss_c", inboxID: "msg_miss_c" }),
      event("session.step.ended", "ses_after", { finish: "stop" }),
    ]
    const h = harness((options) => eventSource(options.signal, events))
    h.setInboxResult(false)
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => h.resets.includes("ses_after"))).toBe(true)
    expect(h.inboxDeliveries).toHaveLength(1)
    expect(h.inboxCancels).toHaveLength(1)
    expect(h.logs).toEqual([])
    h.controller.abort()
    await running
  })
})

describe("server 事件订阅重连", () => {
  test("订阅抛错记录原因并等待 250ms 后重连，不并发消费", async () => {
    const clock = fakeClock()
    let attempts = 0
    let active = 0
    let maxActive = 0
    const h = harness(
      ({ signal }) => {
        attempts += 1
        if (attempts === 1) throw new Error("boom")
        active += 1
        maxActive = Math.max(maxActive, active)
        return {
          async *[Symbol.asyncIterator]() {
            try {
              await waitUntilAborted(signal)
            } finally {
              active -= 1
            }
          },
        }
      },
      { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    )
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => clock.pending.length === 1)).toBe(true)
    expect(attempts).toBe(1)
    expect(h.logs[0]).toMatchObject({
      event: "event-subscription-restart",
      reason: "boom",
      delay: EVENT_SUBSCRIPTION_INITIAL_DELAY_MS,
    })
    await clock.runNext()
    expect(await waitFor(() => attempts === 2)).toBe(true)
    expect(maxActive).toBe(1)
    h.controller.abort()
    await running
  })

  test("正常结束同样重连，原因标为 stream-ended", async () => {
    const clock = fakeClock()
    let attempts = 0
    const h = harness(
      ({ signal }) => {
        attempts += 1
        return attempts === 1 ? (async function* () {})() : eventSource(signal)
      },
      { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    )
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => clock.pending.length === 1)).toBe(true)
    expect(h.logs[0]).toMatchObject({ reason: "stream-ended", delay: 250 })
    await clock.runNext()
    expect(await waitFor(() => attempts === 2)).toBe(true)
    h.controller.abort()
    await running
  })

  test("连续正常结束按 250、500、1000、2000、4000、5000 退避并封顶", async () => {
    const clock = fakeClock()
    let attempts = 0
    const h = harness(() => {
      attempts += 1
      return (async function* () {})()
    }, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
    const running = startServerEventSubscription(h.deps)
    const expected = [250, 500, 1000, 2000, 4000, EVENT_SUBSCRIPTION_MAX_DELAY_MS, EVENT_SUBSCRIPTION_MAX_DELAY_MS]
    for (let index = 0; index < expected.length; index += 1) {
      expect(await waitFor(() => h.logs.length === index + 1)).toBe(true)
      expect(h.logs[index]).toMatchObject({ event: "event-subscription-restart", delay: expected[index] })
      expect(clock.pending[0]?.delay).toBe(expected[index])
      await clock.runNext()
    }
    expect(attempts).toBe(expected.length + 1)
    h.controller.abort()
    await running
  })

  test("成功收到事件后重置退避，下一次断流重新回到 250ms", async () => {
    const clock = fakeClock()
    let attempts = 0
    const h = harness((options) => {
      attempts += 1
      if (attempts === 1) throw new Error("first")
      if (attempts === 2) {
        return (async function* () {
          yield event("session.step.ended", "ses_received", { finish: "stop" })
          throw new Error("after-event")
        })()
      }
      return eventSource(options.signal)
    }, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => h.logs.length === 1)).toBe(true)
    expect(h.logs[0]?.delay).toBe(250)
    await clock.runNext()
    expect(await waitFor(() => h.logs.length === 2)).toBe(true)
    expect(h.resets).toEqual(["ses_received"])
    expect(h.logs[1]).toMatchObject({ reason: "after-event", delay: 250 })
    h.controller.abort()
    await running
  })

  test("退避等待中 abort 清定时器，不再 subscribe，也无未处理拒绝", async () => {
    const clock = fakeClock()
    let attempts = 0
    const unhandled: unknown[] = []
    const onUnhandled = (cause: unknown) => unhandled.push(cause)
    process.on("unhandledRejection", onUnhandled)
    try {
      const h = harness(() => {
        attempts += 1
        throw new Error("disconnect")
      }, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
      const running = startServerEventSubscription(h.deps)
      expect(await waitFor(() => clock.pending.length === 1)).toBe(true)
      const timerID = (clock.pending[0] as any).id
      h.controller.abort()
      await running
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(attempts).toBe(1)
      expect(clock.pending).toHaveLength(0)
      expect(clock.cleared).toContain(timerID)
      expect(h.logs).toHaveLength(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("活动流在 abort 后以 AbortError 拒绝也只结束 Promise，不重连", async () => {
    let attempts = 0
    const unhandled: unknown[] = []
    const onUnhandled = (cause: unknown) => unhandled.push(cause)
    process.on("unhandledRejection", onUnhandled)
    try {
      const h = harness(({ signal }) => {
        attempts += 1
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
                once: true,
              })
            })
          },
        }
      })
      const running = startServerEventSubscription(h.deps)
      expect(await waitFor(() => attempts === 1)).toBe(true)
      h.controller.abort()
      await running
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(attempts).toBe(1)
      expect(h.logs).toEqual([])
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("订阅参数固定为十类事件，并复用 setup 的 abort signal", async () => {
    let captured: any
    const h = harness((options) => {
      captured = options
      return eventSource(options.signal)
    })
    const running = startServerEventSubscription(h.deps)
    expect(await waitFor(() => captured !== undefined)).toBe(true)
    expect(captured.types).toEqual(SERVER_EVENT_TYPES)
    expect(captured.signal).toBe(h.controller.signal)
    h.controller.abort()
    await running
  })
})
