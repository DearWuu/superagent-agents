/**
 * 看护项淘汰的 runtime 清理：TTL 与数量上限都不能留下陈旧运行标记。
 */
import { describe, expect, test } from "bun:test"

import { createStatusWatcher } from "./subagent-status"

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function harness(clearError = false) {
  const cleared: string[] = []
  const writes: Record<string, any>[] = []
  let reads = 0
  const deps = {
    readSession: async (sessionID: string) => {
      reads += 1
      return { id: sessionID, outcome: null, time: { busy: 10 } }
    },
    readMessages: async () => [],
    readEntries: async () => [],
    notifyParent: async () => {},
    markRuntime: async () => {},
    clearRuntime: async (sessionID: string) => {
      cleared.push(sessionID)
      if (clearError) throw new Error("clear failed")
    },
    write: (record: Record<string, unknown>) => writes.push(record),
    settleRetryLimit: 0,
  }
  return { deps, cleared, writes, reads: () => reads }
}

function input(index: number) {
  return {
    childID: `ses_${index}`,
    parentID: "ses_parent",
    rootID: "ses_root",
    description: `任务 ${index}`,
    agent: "worker",
    background: true,
  }
}

describe("watch 淘汰清理", () => {
  test("TTL 淘汰 best-effort clearRuntime；失败只记日志", async () => {
    const { deps, cleared, writes, reads } = harness(true)
    const watcher = createStatusWatcher(deps)
    const originalNow = Date.now
    try {
      await watcher.register(input(0))
      await waitFor(() => reads() >= 1)
      Date.now = () => originalNow() + 7 * 60 * 60 * 1000
      await watcher.reconcile()
      expect(watcher.size()).toBe(0)
      expect(cleared).toEqual(["ses_0"])
      expect(writes.some((record) => record.event === "status-notify-failed" && record.reason === "watch-ttl")).toBe(true)
    } finally {
      Date.now = originalNow
      watcher.stop()
    }
  })

  test("WATCH_LIMIT 淘汰最旧 watch 时清 runtime 并取消旧 retry", async () => {
    const { deps, cleared } = harness()
    const watcher = createStatusWatcher(deps)
    try {
      for (let index = 0; index < 201; index += 1) await watcher.register(input(index))
      expect(watcher.size()).toBe(200)
      expect(cleared).toContain("ses_0")
    } finally {
      watcher.stop()
    }
  })
})
