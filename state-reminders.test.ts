/**
 * 对账提醒的轮次与批次隔离：旧轮已提醒状态、parent 基线和总预算不得残留。
 */
import { expect, test } from "bun:test"

import { createStatusWatcher } from "./subagent-status"

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test("对账读取 parent 期间 stop：迟到的提醒不再投递", async () => {
  const notices: any[] = []
  let releaseParentRead: (() => void) | undefined
  let parentRead = false
  const watcher = createStatusWatcher({
    reconcileIntervalMs: 10,
    settleRetryLimit: 0,
    readSession: async (sessionID: string) =>
      sessionID === "ses_child"
        ? { id: sessionID, outcome: "succeeded", time: { busy: 10, idle: 20 } }
        : { id: sessionID, time: { busy: 1, idle: 2 } },
    readMessages: async (sessionID: string) => {
      if (sessionID !== "ses_parent") return []
      parentRead = true
      await new Promise<void>((resolve) => {
        releaseParentRead = resolve
      })
      return []
    },
    readEntries: async () => [],
    notifyParent: async (input: any) => notices.push(input),
    markRuntime: async () => {},
    clearRuntime: async () => {},
    write: () => {},
  })
  await watcher.register({
    childID: "ses_child",
    parentID: "ses_parent",
    rootID: "ses_root",
    description: "任务",
    agent: "worker",
    background: true,
  })
  const round = watcher.reconcile()
  while (!parentRead) await delay(5)
  watcher.stop()
  releaseParentRead?.()
  await round
  expect(notices).toEqual([])
})

test("新轮重置提醒状态和 parent 基线，空批后重置总提醒预算", async () => {
  const notices: any[] = []
  const parentMessages: any[] = []
  const cleared: string[] = []
  let reads = 0
  let child: any = { id: "ses_child", outcome: null, time: { busy: 10 } }
  const watcher = createStatusWatcher({
    reconcileIntervalMs: 10,
    settleRetryLimit: 0,
    readSession: async (sessionID: string) => {
      if (sessionID === "ses_child") {
        reads += 1
        return child
      }
      return { id: sessionID, time: { busy: 1, idle: 2 } }
    },
    readMessages: async (sessionID: string) => (sessionID === "ses_parent" ? parentMessages : []),
    readEntries: async () => [],
    notifyParent: async (input: any) => notices.push(input),
    markRuntime: async () => {},
    clearRuntime: async (sessionID: string) => cleared.push(sessionID),
    write: () => {},
  })
  const registration = {
    childID: "ses_child",
    parentID: "ses_parent",
    rootID: "ses_root",
    description: "任务",
    agent: "worker",
    background: true,
  }
  const originalNow = Date.now
  try {
    await watcher.register(registration)
    await waitFor(() => reads >= 1)
    child = { id: "ses_child", outcome: "succeeded", time: { busy: 10, idle: 20 } }
    await watcher.reconcile()
    await delay(15)
    await watcher.reconcile()
    expect(notices).toHaveLength(1)

    // 第二轮：旧轮 remindedStates 与 parent baseline 都不能压制新提醒。
    child = { id: "ses_child", outcome: null, time: { busy: 30 } }
    await watcher.register(registration)
    await delay(5)
    parentMessages.push({ type: "assistant", text: "parent 已继续工作", time: { created: Date.now() } })
    child = { id: "ses_child", outcome: "succeeded", time: { busy: 30, idle: 40 } }
    await watcher.reconcile()
    await delay(15)
    await watcher.reconcile()
    expect(notices).toHaveLength(2)

    // 当前批 TTL 清空后，新批重新获得两次总预算，而不是永久禁言。
    Date.now = () => originalNow() + 7 * 60 * 60 * 1000
    await watcher.reconcile()
    Date.now = originalNow
    expect(watcher.size()).toBe(0)
    expect(cleared).toEqual(["ses_child"])

    child = { id: "ses_child", outcome: null, time: { busy: 50 } }
    await watcher.register(registration)
    child = { id: "ses_child", outcome: "succeeded", time: { busy: 50, idle: 60 } }
    await watcher.reconcile()
    await delay(15)
    await watcher.reconcile()
    expect(notices).toHaveLength(3)
  } finally {
    Date.now = originalNow
    watcher.stop()
  }
})
