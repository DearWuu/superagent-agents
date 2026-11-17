/**
 * 状态看护的跨轮回归：旧通知判重、busy retry、dispose 与非终态误完成。
 */
import { describe, expect, test } from "bun:test"

import { createStatusWatcher, terminalNoticeSeen } from "./subagent-status"

const CHILD = "ses_child"
const PARENT = "ses_parent"

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function harness(overrides: Record<string, unknown> = {}) {
  const notices: any[] = []
  const parentMessages: any[] = []
  const writes: Record<string, any>[] = []
  const deps = {
    readSession: async (sessionID: string) => ({
      id: sessionID,
      outcome: "succeeded",
      time: { busy: 10, idle: 20 },
    }),
    readMessages: async (sessionID: string) => (sessionID === PARENT ? parentMessages : []),
    readEntries: async () => [],
    notifyParent: async (input: any) => {
      notices.push(input)
      parentMessages.push({ ...input, time: { created: Date.now() } })
    },
    markRuntime: async () => {},
    clearRuntime: async () => {},
    write: (record: Record<string, unknown>) => writes.push(record),
    ...overrides,
  }
  return { deps, notices, parentMessages, writes }
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

describe("状态轮次隔离", () => {
  test("terminalNoticeSeen 时间界可选；旧轮终态卡不能命中新轮", () => {
    const oldCard = {
      time: { created: 10_000 },
      metadata: { source: "subagent", childID: CHILD, state: "completed" },
      text: `<subagent sessionID="${CHILD}" state="completed">old</subagent>`,
    }
    expect(terminalNoticeSeen([oldCard], CHILD, "completed")).toBe(true)
    expect(terminalNoticeSeen([oldCard], CHILD, "completed", 11_000)).toBe(false)
    expect(terminalNoticeSeen([{ ...oldCard, time: { created: 11_000 } }], CHILD, "completed", 11_000)).toBe(true)
  })

  test("同一 child 连续两轮各自收到完成通知，不被旧卡判重", async () => {
    const { deps, notices, parentMessages } = harness()
    const watcher = createStatusWatcher(deps)
    try {
      await watcher.register(registration())
      watcher.settle(CHILD, { state: "completed" })
      await waitFor(() => notices.length === 1)
      await waitFor(() => watcher.size() === 0)

      // 模拟第一轮通知已成为历史消息；第二轮仍需独立通知。
      parentMessages[0].time.created = Date.now() - 2000
      await watcher.register(registration())
      watcher.settle(CHILD, { state: "completed" })
      await waitFor(() => notices.length === 2)
      expect(notices.map((notice) => notice.metadata.state)).toEqual(["completed", "completed"])
    } finally {
      watcher.stop()
    }
  })

  test("新轮取消旧 pending retry，旧轮预算与定时器不串轮", async () => {
    let round = 1
    let secondRoundAt = 0
    let reads = 0
    const { deps, notices } = harness({
      settleRetryMs: 100,
      settleRetryLimit: 1,
      readSession: async (sessionID: string) => {
        reads += 1
        const busy = round === 1 || Date.now() - secondRoundAt < 70
        return {
          id: sessionID,
          outcome: busy ? null : "succeeded",
          time: busy ? { busy: 10 } : { busy: 10, idle: 20 },
        }
      },
    })
    const watcher = createStatusWatcher(deps)
    try {
      await watcher.register(registration())
      await waitFor(() => reads >= 1)
      // 让旧 retry 在新轮开始后很快触发；新轮自己的 retry 应获得完整延迟。
      await delay(75)
      round = 2
      secondRoundAt = Date.now()
      await watcher.register(registration())
      // 新轮自己的 execution 终态事件：应升级旧初探，而不是被旧预算吞掉。
      watcher.settle(CHILD, { state: "completed" })
      await waitFor(() => notices.length === 1)
      expect(notices[0].metadata.state).toBe("completed")
    } finally {
      watcher.stop()
    }
  })

  test("本轮已落盘 idle 的后台派发仍立即补发完成通知", async () => {
    const { deps, notices } = harness({
      readSession: async (sessionID: string) => ({
        id: sessionID,
        outcome: "succeeded",
        time: { busy: Date.now() - 10, idle: Date.now() },
      }),
    })
    const watcher = createStatusWatcher(deps)
    try {
      await watcher.register(registration())
      await waitFor(() => notices.length === 1)
      expect(notices[0].metadata.state).toBe("completed")
      expect(watcher.size()).toBe(0)
    } finally {
      watcher.stop()
    }
  })

  test("旧轮等待原生通知时发生 steer，旧收尾不能删除或通知新轮", async () => {
    let childRead = false
    const { deps, notices } = harness({
      settleRetryLimit: 0,
      readSession: async (sessionID: string) => ({
        id: sessionID,
        // 旧轮 outcome/idle 残留也不能让新轮 register 立即判完成。
        outcome: "succeeded",
        time: { busy: 10, idle: 20 },
      }),
      readMessages: async (sessionID: string) => {
        if (sessionID === CHILD) childRead = true
        return []
      },
    })
    const watcher = createStatusWatcher(deps)
    try {
      await watcher.register(registration())
      await waitFor(() => childRead)
      await watcher.register(registration())
      // 等旧轮 1.2s 原生通知窗口与新轮自己的收尾都走完。
      await delay(2800)
      expect(notices).toEqual([])
      expect(watcher.size()).toBe(1)
    } finally {
      watcher.stop()
    }
  })

  test("同 child 新轮重置后台通知状态，相同任务签名仍重新通知", async () => {
    const runningShell = {
      type: "shell",
      shellID: "sh_1",
      command: "npm run dev",
      status: "running",
      metadata: { background: true },
    }
    const { deps, notices } = harness({ readMessages: async () => [runningShell] })
    const watcher = createStatusWatcher(deps)
    try {
      await watcher.register(registration())
      await waitFor(() => notices.length === 1)
      await watcher.register(registration())
      await waitFor(() => notices.length === 2)
      expect(notices.map((notice) => notice.metadata.state)).toEqual(["idle-background", "idle-background"])
      expect(watcher.size()).toBe(1)
    } finally {
      watcher.stop()
    }
  })

  test("等待原生通知期间 stop，不再投递迟到完成通知", async () => {
    let childRead = false
    const { deps, notices } = harness({
      readMessages: async (sessionID: string) => {
        if (sessionID === CHILD) childRead = true
        return []
      },
    })
    const watcher = createStatusWatcher(deps)
    await watcher.register(registration())
    await waitFor(() => childRead)
    watcher.stop()
    await delay(1400)
    expect(notices).toEqual([])
  })

  test("无 outcome 且无 busy/idle 的 shell 收尾不默认成 completed", async () => {
    let current: any = { id: CHILD, outcome: null, time: { busy: 10 } }
    let reads = 0
    const { deps, notices } = harness({
      settleRetryLimit: 0,
      readSession: async () => {
        reads += 1
        return current
      },
      readMessages: async () => [
        { type: "assistant", content: [{ type: "text", text: "仍在调用工具" }] },
      ],
    })
    const watcher = createStatusWatcher(deps)
    try {
      await watcher.register(registration())
      await waitFor(() => reads >= 1)
      // 模拟 shell ended 时执行仍在 streaming，但 busy/idle 尚未落库。
      current = { id: CHILD, outcome: null, time: { created: 1 } }
      watcher.settle(CHILD)
      await delay(1400)
      expect(notices).toEqual([])
      expect(watcher.size()).toBe(1)

      // 即使事件接线显式给 completed，没有会话侧终态证据也不能误报。
      watcher.settle(CHILD, { state: "completed" })
      await delay(1400)
      expect(notices).toEqual([])
      expect(watcher.size()).toBe(1)

      current = { id: CHILD, outcome: "succeeded", time: { busy: 10, idle: 20 } }
      watcher.settle(CHILD, { state: "completed" })
      await waitFor(() => notices.length === 1)
      expect(notices[0].metadata.state).toBe("completed")
    } finally {
      watcher.stop()
    }
  })
})
