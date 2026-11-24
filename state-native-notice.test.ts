/**
 * 原生 inbox.enqueued 观察与完成通知延迟兜底。
 * server 事件解析不在本文件范围内，这里直接驱动 watcher 公共观察 API。
 */
import { describe, expect, test } from "bun:test"

import {
  createStatusWatcher,
  formatCompletionNotice,
  MAX_NOTICE_TEXT_LENGTH,
  type CompletionState,
} from "./subagent-status"

const CHILD = "ses_child"
const PARENT = "ses_parent"

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function runningShell() {
  return {
    type: "shell",
    shellID: "sh_1",
    command: "npm run dev",
    status: "running",
    metadata: { background: true },
  }
}

function harness(overrides: Record<string, unknown> = {}) {
  const notices: any[] = []
  const parentMessages: any[] = []
  const writes: Record<string, any>[] = []
  const cleared: string[] = []
  const marked: unknown[] = []
  const evicted: string[] = []
  let childMessages: any[] = []
  let childReads = 0
  let child: any = { id: CHILD, outcome: null, time: { busy: 10 } }
  let parent: any = { id: PARENT, time: { busy: 1, idle: 2 } }
  const deps = {
    nativeNoticeWaitMs: 5,
    reconcileIntervalMs: 60_000,
    settleRetryLimit: 0,
    readSession: async (sessionID: string) => {
      if (sessionID !== CHILD) return structuredClone(parent)
      childReads += 1
      return structuredClone(child)
    },
    readMessages: async (sessionID: string) => sessionID === PARENT ? parentMessages : childMessages,
    readEntries: async () => [],
    notifyParent: async (input: any) => {
      notices.push(input)
    },
    markRuntime: async (_sessionID: string, jobs: unknown) => {
      marked.push(jobs)
    },
    clearRuntime: async (sessionID: string) => {
      cleared.push(sessionID)
    },
    evictExcess: async (input: { childID: string }) => {
      evicted.push(input.childID)
    },
    write: (record: Record<string, unknown>) => writes.push(record),
    ...overrides,
  }
  return {
    deps,
    notices,
    parentMessages,
    writes,
    cleared,
    marked,
    evicted,
    childReads: () => childReads,
    setParent(next: any) {
      parent = next
    },
    setMessages(messages: any[]) {
      childMessages = messages
    },
    complete(state: CompletionState = "completed") {
      const outcome = state === "completed" ? "succeeded" : state === "error" ? "failed" : "interrupted"
      child = { id: CHILD, outcome, time: { busy: 10, idle: 20 } }
    },
  }
}

function registration(background = true) {
  return {
    childID: CHILD,
    parentID: PARENT,
    rootID: "ses_root",
    description: "任务",
    agent: "worker",
    background,
  }
}

async function register(watcher: ReturnType<typeof createStatusWatcher>, h: ReturnType<typeof harness>, background = true) {
  await watcher.register(registration(background))
  await waitFor(() => h.childReads() >= 1)
}

async function waitPending(h: ReturnType<typeof harness>, count = 1) {
  await waitFor(() => h.writes.filter((record) => record.event === "status-completion-pending").length >= count)
}

describe("原生通知观察与终态兜底", () => {
  test("enqueued 且 delivered：零插件卡并正常收尾淘汰", async () => {
    const h = harness()
    const watcher = createStatusWatcher(h.deps)
    try {
      await register(watcher, h)
      expect(watcher.observeNativeNotice({
        childID: CHILD,
        state: "completed",
        text: `<subagent sessionID="${CHILD}" state="completed">done</subagent>`,
        time: Date.now(),
        inboxID: "inbox_done",
      })).toBe(true)
      expect(watcher.observeNativeDelivery({ inboxID: "inbox_done", time: Date.now() })).toBe(true)
      h.complete()
      watcher.settle(CHILD, { state: "completed" })
      await waitFor(() => watcher.size() === 0)
      expect(h.notices).toEqual([])
      expect(h.cleared).toEqual([CHILD])
      expect(h.evicted).toEqual([CHILD])
      await watcher.reconcile()
      expect(h.notices).toEqual([])
    } finally {
      watcher.stop()
    }
  })

  test("无 native：settle 不立即发，首个 reconcile 发一张完整完成卡", async () => {
    const h = harness()
    h.setMessages([{ type: "assistant", content: [{ type: "text", text: "最终报告" }] }])
    const watcher = createStatusWatcher(h.deps)
    try {
      await register(watcher, h)
      h.complete()
      watcher.settle(CHILD, { state: "completed" })
      await waitPending(h)
      expect(h.notices).toEqual([])
      expect(watcher.size()).toBe(1)

      await watcher.reconcile()
      expect(h.notices).toHaveLength(1)
      expect(h.notices[0].metadata).toEqual({ source: "superagent-agents", childID: CHILD, state: "completed" })
      expect(h.notices[0].text).toContain("最终报告")
      expect(h.notices[0].text).toContain('<subagent sessionID="ses_child" state="completed"')
      expect(h.notices[0].text).not.toContain("如已知晓可忽略")
      expect(h.writes.some((record) => record.event === "status-completion-fallback")).toBe(true)
      expect(watcher.size()).toBe(0)
      expect(h.cleared).toEqual([CHILD])
      expect(h.evicted).toEqual([CHILD])

      await watcher.reconcile()
      expect(h.notices).toHaveLength(1)
    } finally {
      watcher.stop()
    }
  })

  test("pending 后 native 才入队并投递：下一拍只收尾，不补插件卡", async () => {
    const h = harness()
    const watcher = createStatusWatcher(h.deps)
    try {
      await register(watcher, h)
      h.complete()
      watcher.settle(CHILD, { state: "completed" })
      await waitPending(h)
      watcher.observeNativeNotice({ childID: CHILD, state: "succeeded", text: "done", time: Date.now(), inboxID: "inbox_late" })
      watcher.observeNativeDelivery({ inboxID: "inbox_late", time: Date.now() })
      await watcher.reconcile()
      expect(h.notices).toEqual([])
      expect(watcher.size()).toBe(0)
    } finally {
      watcher.stop()
    }
  })

  test("旧轮、异状态与 background-running 都不能冒充本轮匹配终态", async () => {
    const h = harness()
    const watcher = createStatusWatcher(h.deps)
    try {
      await register(watcher, h)
      // 旧轮迟到事件：入队时间早于本轮开始，必须拒绝。
      expect(watcher.observeNativeNotice({ childID: CHILD, state: "completed", time: Date.now() - 5_000 })).toBe(false)
      expect(watcher.observeNativeNotice({ childID: CHILD, state: "error", text: "failed", time: Date.now() })).toBe(true)
      expect(watcher.observeNativeNotice({
        childID: CHILD,
        state: "completed",
        text: `<subagent sessionID="${CHILD}" state="running">Background work still running</subagent>`,
        time: Date.now(),
      })).toBe(true)
      h.complete()
      watcher.settle(CHILD, { state: "completed" })
      await waitPending(h)
      expect(watcher.size()).toBe(1)

      // 新轮清空旧观察；即使旧轮 completed 入队也不能吞掉新轮兜底。
      watcher.observeNativeNotice({ childID: CHILD, state: "completed", text: "old", time: Date.now() })
      await watcher.register(registration())
      await waitFor(() => h.childReads() >= 2)
      h.complete()
      watcher.settle(CHILD, { state: "completed" })
      await waitPending(h, 2)
      await watcher.reconcile()
      expect(h.notices).toHaveLength(1)
      expect(h.notices[0].metadata.state).toBe("completed")
    } finally {
      watcher.stop()
    }
  })

  test("入队门槛容忍 1 秒时钟偏差：本轮开始前刚入队的原生卡仍算本轮", async () => {
    const h = harness()
    const watcher = createStatusWatcher(h.deps)
    try {
      const before = Date.now()
      await register(watcher, h)
      // 入队时间比本轮开始早不到 1 秒：属于时钟偏差，不能当旧轮丢掉。
      expect(watcher.observeNativeNotice({ childID: CHILD, state: "completed", time: before - 100 })).toBe(true)
      // 早于偏差容忍窗口：仍然是旧轮事件，必须拒绝。
      expect(watcher.observeNativeNotice({ childID: CHILD, state: "error", text: "failed", time: before - 5_000 })).toBe(false)
    } finally {
      watcher.stop()
    }
  })

  test("兜底通知失败保留 pending，下一拍成功后只投递一张", async () => {
    let attempts = 0
    let fail = true
    const delivered: any[] = []
    const h = harness({
      notifyParent: async (input: any) => {
        attempts += 1
        if (fail) throw new Error("inbox unavailable")
        delivered.push(input)
      },
    })
    const watcher = createStatusWatcher(h.deps)
    try {
      await register(watcher, h)
      h.complete("error")
      watcher.settle(CHILD, { state: "error" })
      await waitPending(h)
      await watcher.reconcile()
      expect(attempts).toBe(1)
      expect(delivered).toEqual([])
      expect(watcher.size()).toBe(1)
      expect(h.writes.some((record) => record.event === "status-notify-failed" && record.phase === "completion")).toBe(true)

      fail = false
      await watcher.reconcile()
      expect(attempts).toBe(2)
      expect(delivered).toHaveLength(1)
      expect(delivered[0].metadata.state).toBe("error")
      expect(delivered[0].text).toContain("子代理执行失败")
      expect(watcher.size()).toBe(0)
      await watcher.reconcile()
      expect(attempts).toBe(2)
    } finally {
      watcher.stop()
    }
  })
})

describe("原生 background-running 去重", () => {
  test("重复观察不双发 background；后台结束仍发 BACKGROUND_DONE_TEXT", async () => {
    const h = harness()
    h.complete()
    h.setMessages([runningShell()])
    const watcher = createStatusWatcher(h.deps)
    try {
      await watcher.register(registration(false))
      expect(watcher.observeNativeNotice({
        childID: CHILD,
        state: "completed",
        text: `<subagent sessionID="${CHILD}" state="running">Background work still running</subagent>`,
        time: Date.now(),
        inboxID: "inbox_bg",
      })).toBe(true)
      expect(watcher.observeNativeDelivery({ inboxID: "inbox_bg", time: Date.now() })).toBe(true)
      await waitFor(() => h.marked.length === 1)
      expect(h.notices).toEqual([])
      expect(watcher.size()).toBe(1)

      watcher.observeNativeNotice({ childID: CHILD, state: "running", text: "still running", time: Date.now() })
      watcher.settle(CHILD)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(h.notices).toEqual([])
      expect(h.marked).toHaveLength(1)

      h.setMessages([{ ...runningShell(), status: "exited" }])
      watcher.settle(CHILD, { state: "completed" })
      await waitFor(() => h.notices.length === 1)
      expect(h.notices[0].metadata.state).toBe("completed")
      expect(h.notices[0].text).toContain("子代理的后台任务已全部结束。")
      expect(h.cleared).toEqual([CHILD])
      expect(watcher.size()).toBe(0)
    } finally {
      watcher.stop()
    }
  })

  test("原生后台卡仅入队未投递：父忙与父闲都不补发插件后台卡", async () => {
    const parents = [
      { id: PARENT, time: { busy: 30 } },
      { id: PARENT, time: { busy: 1, idle: 40 } },
    ]
    for (const parent of parents) {
      const h = harness()
      h.complete()
      h.setMessages([runningShell()])
      h.setParent(parent)
      const watcher = createStatusWatcher(h.deps)
      try {
        await watcher.register(registration())
        expect(watcher.observeNativeNotice({
          childID: CHILD,
          state: "running",
          text: `<subagent sessionID="${CHILD}" state="running">Background work still running</subagent>`,
          time: Date.now(),
          inboxID: "inbox_bg_queued",
        })).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 30))
        // 后台卡不承担唤醒：只入队就足以判重，不能等 delivered。
        expect(h.marked).toHaveLength(1)
        expect(h.notices).toEqual([])
        expect(watcher.size()).toBe(1)
      } finally {
        watcher.stop()
      }
    }
  })
})

describe("完成卡长度", () => {
  test("description 与 body 共用 4000 字预算，标签完整闭合", () => {
    const text = formatCompletionNotice({
      childID: CHILD,
      description: "d".repeat(5000),
      state: "completed",
      text: "b".repeat(5000),
    })
    expect(text.length).toBe(MAX_NOTICE_TEXT_LENGTH)
    expect(text.startsWith(`<subagent sessionID="${CHILD}" state="completed" description="`)).toBe(true)
    expect(text.slice(0, text.indexOf("\n"))).toContain('description="')
    expect(text.slice(0, text.indexOf("\n")).endsWith('">')).toBe(true)
    expect(text.endsWith("\n</subagent>")).toBe(true)
  })
})

describe("enqueued 与 delivered 回标", () => {
  test("仅 enqueued 未 delivered：父忙（含读取失败）不补发且 blocked 日志一次，父闲后补发", async () => {
    const h = harness()
    let failParentRead = false
    const originalRead = h.deps.readSession
    h.deps.readSession = async (sessionID: string) => {
      if (sessionID === PARENT && failParentRead) throw new Error("parent read failed")
      return originalRead(sessionID)
    }
    const watcher = createStatusWatcher(h.deps)
    try {
      await register(watcher, h)
      watcher.observeNativeNotice({
        childID: CHILD,
        state: "completed",
        text: `<subagent sessionID="${CHILD}" state="completed">done</subagent>`,
        time: Date.now(),
        inboxID: "inbox_queued",
      })
      h.complete()
      watcher.settle(CHILD, { state: "completed" })
      await waitPending(h)

      // 读取失败按忙处理：不发卡。
      failParentRead = true
      await watcher.reconcile()
      expect(h.notices).toEqual([])
      expect(watcher.size()).toBe(1)
      const blocked = () => h.writes.filter((record) => record.event === "status-completion-blocked")
      expect(blocked()).toHaveLength(1)
      expect(blocked()[0]).toMatchObject({ childSessionID: CHILD, parentID: PARENT, state: "completed" })

      // 父会话只有 busy：视为忙，blocked 日志不重复。
      failParentRead = false
      h.setParent({ id: PARENT, time: { busy: 30 } })
      await watcher.reconcile()
      expect(h.notices).toEqual([])
      expect(blocked()).toHaveLength(1)
      expect(watcher.size()).toBe(1)

      // 父会话空闲：走既有补发，pending 收尾。
      h.setParent({ id: PARENT, time: { busy: 1, idle: 40 } })
      await watcher.reconcile()
      expect(h.notices).toHaveLength(1)
      expect(h.notices[0].metadata.state).toBe("completed")
      expect(h.writes.some((record) => record.event === "status-completion-fallback")).toBe(true)
      expect(watcher.size()).toBe(0)
    } finally {
      watcher.stop()
    }
  })

  test("native 入队后被 cancelled：不算 seen，对账补发并写 status-native-cancelled", async () => {
    const h = harness()
    const watcher = createStatusWatcher(h.deps)
    try {
      await register(watcher, h)
      watcher.observeNativeNotice({
        childID: CHILD,
        state: "completed",
        text: `<subagent sessionID="${CHILD}" state="completed">done</subagent>`,
        time: Date.now(),
        inboxID: "inbox_cancelled",
      })
      expect(watcher.observeNativeCancel({ inboxID: "inbox_cancelled", time: Date.now() })).toBe(true)
      expect(h.writes.some((record) => record.event === "status-native-cancelled")).toBe(true)
      h.complete()
      watcher.settle(CHILD, { state: "completed" })
      await waitPending(h)
      expect(watcher.size()).toBe(1)

      await watcher.reconcile()
      expect(h.notices).toHaveLength(1)
      expect(h.notices[0].metadata.state).toBe("completed")
      expect(watcher.size()).toBe(0)
    } finally {
      watcher.stop()
    }
  })

  test("inboxID 分别映射 background 与 terminal 两张卡；未知 inboxID 不命中", async () => {
    const h = harness()
    h.complete()
    h.setMessages([runningShell()])
    const watcher = createStatusWatcher(h.deps)
    try {
      await watcher.register(registration(false))
      watcher.observeNativeNotice({
        childID: CHILD,
        state: "completed",
        text: `<subagent sessionID="${CHILD}" state="running">Background work still running</subagent>`,
        time: Date.now(),
        inboxID: "inbox_bg",
      })
      watcher.observeNativeDelivery({ inboxID: "inbox_bg", time: Date.now() })
      await waitFor(() => h.marked.length === 1)
      expect(h.notices).toEqual([])

      // 后台全部结束 + 原生终态卡入队并投递：BACKGROUND_DONE 不再补发。
      h.setMessages([{ ...runningShell(), status: "exited" }])
      watcher.observeNativeNotice({
        childID: CHILD,
        state: "completed",
        text: `<subagent sessionID="${CHILD}" state="completed">done</subagent>`,
        time: Date.now(),
        inboxID: "inbox_term",
      })
      watcher.observeNativeDelivery({ inboxID: "inbox_term", time: Date.now() })
      watcher.settle(CHILD, { state: "completed" })
      await waitFor(() => watcher.size() === 0)
      expect(h.notices).toEqual([])
      expect(h.cleared).toEqual([CHILD])

      expect(watcher.observeNativeDelivery({ inboxID: "inbox_unknown", time: Date.now() })).toBe(false)
      expect(watcher.observeNativeCancel({ inboxID: "", time: Date.now() })).toBe(false)
    } finally {
      watcher.stop()
    }
  })

  test("delivered 回标后旧轮观察在新轮不算 seen", async () => {
    const h = harness()
    const watcher = createStatusWatcher(h.deps)
    try {
      await register(watcher, h)
      watcher.observeNativeNotice({
        childID: CHILD,
        state: "completed",
        text: "done",
        time: Date.now(),
        inboxID: "inbox_old",
      })
      watcher.observeNativeDelivery({ inboxID: "inbox_old", time: Date.now() })
      // 新轮清空旧观察：回标已无命中。
      await watcher.register(registration())
      expect(watcher.observeNativeDelivery({ inboxID: "inbox_old", time: Date.now() })).toBe(false)
      h.complete()
      watcher.settle(CHILD, { state: "completed" })
      await waitPending(h)
      await watcher.reconcile()
      expect(h.notices).toHaveLength(1)
    } finally {
      watcher.stop()
    }
  })

  test("终态判重仍要求 delivered：仅 enqueued 不算 seen，父闲时对账补发", async () => {
    const h = harness()
    const watcher = createStatusWatcher(h.deps)
    try {
      await register(watcher, h)
      expect(watcher.observeNativeNotice({
        childID: CHILD,
        state: "completed",
        text: `<subagent sessionID="${CHILD}" state="completed">done</subagent>`,
        time: Date.now(),
        inboxID: "inbox_terminal_queued",
      })).toBe(true)
      h.complete()
      watcher.settle(CHILD, { state: "completed" })
      await waitPending(h)
      expect(h.notices).toEqual([])

      // 父闲：仅入队未投递不算 seen，对账补发且只补一张。
      await watcher.reconcile()
      expect(h.notices).toHaveLength(1)
      expect(h.notices[0].metadata).toEqual({ source: "superagent-agents", childID: CHILD, state: "completed" })
      expect(h.writes.some((record) => record.event === "status-completion-fallback")).toBe(true)
      expect(watcher.size()).toBe(0)
    } finally {
      watcher.stop()
    }
  })

  test("已投递的后台卡不能冒充终态：终态未 delivered 时仍补发完成卡", async () => {
    const h = harness()
    h.complete()
    h.setMessages([runningShell()])
    const watcher = createStatusWatcher(h.deps)
    try {
      await watcher.register(registration(false))
      expect(watcher.observeNativeNotice({
        childID: CHILD,
        state: "running",
        text: `<subagent sessionID="${CHILD}" state="running">Background work still running</subagent>`,
        time: Date.now(),
        inboxID: "inbox_bg_delivered",
      })).toBe(true)
      expect(watcher.observeNativeDelivery({ inboxID: "inbox_bg_delivered", time: Date.now() })).toBe(true)
      await waitFor(() => h.marked.length === 1)
      expect(h.notices).toEqual([])

      // 后台任务结束、回合终态：后台卡已投递也不能算终态已通知，仍要走 BACKGROUND_DONE。
      h.setMessages([{ ...runningShell(), status: "exited" }])
      watcher.settle(CHILD, { state: "completed" })
      await waitFor(() => h.notices.length === 1)
      expect(h.notices[0].metadata.state).toBe("completed")
      expect(h.notices[0].text).toContain("子代理的后台任务已全部结束。")
      expect(watcher.size()).toBe(0)
    } finally {
      watcher.stop()
    }
  })
})
