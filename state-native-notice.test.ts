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
  const deps = {
    nativeNoticeWaitMs: 5,
    reconcileIntervalMs: 60_000,
    settleRetryLimit: 0,
    readSession: async (sessionID: string) => {
      if (sessionID !== CHILD) return { id: sessionID, time: { busy: 1, idle: 2 } }
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
  test("native 已观察但 parent context 不可见：零插件卡并正常收尾淘汰", async () => {
    const h = harness()
    const watcher = createStatusWatcher(h.deps)
    try {
      await register(watcher, h)
      expect(watcher.observeNativeNotice({
        childID: CHILD,
        state: "completed",
        text: `<subagent sessionID="${CHILD}" state="completed">done</subagent>`,
        time: Date.now(),
      })).toBe(true)
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

  test("pending 后 native 才入队：下一拍只收尾，不补插件卡", async () => {
    const h = harness()
    const watcher = createStatusWatcher(h.deps)
    try {
      await register(watcher, h)
      h.complete()
      watcher.settle(CHILD, { state: "completed" })
      await waitPending(h)
      watcher.observeNativeNotice({ childID: CHILD, state: "succeeded", text: "done", time: Date.now() })
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
      expect(watcher.observeNativeNotice({ childID: CHILD, state: "completed", time: Date.now() - 1 })).toBe(false)
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
      })).toBe(true)
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
