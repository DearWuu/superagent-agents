/** 淘汰入口：顶层异常不变成未处理 rejection，提示一次后下一轮照常重试。 */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createEvictionActions } from "./panel-eviction"

const stateDir = mkdtempSync(path.join(tmpdir(), "panel-eviction-"))
process.env.SUPERAGENT_STATE_DIR = stateDir

afterAll(() => {
  delete process.env.SUPERAGENT_STATE_DIR
  rmSync(stateDir, { recursive: true, force: true })
})

test("顶层异常被收住并提示，复位后下一轮照常淘汰", async () => {
  const toasts: string[] = []
  const removed: string[] = []
  let fail = true
  const context = {
    data: { session: { status: () => "idle" } },
    client: {
      session: {
        remove: async ({ sessionID }: { sessionID: string }) => {
          removed.push(sessionID)
        },
      },
    },
    ui: { toast: { show: ({ message }: { message: string }) => toasts.push(message) } },
  }
  const children = [
    { id: "old", title: "旧", status: "idle", outcome: "succeeded", time: { created: 1, updated: 1 } },
    { id: "new", title: "新", status: "idle", outcome: "succeeded", time: { created: 2, updated: 2 } },
  ]
  const actions = createEvictionActions({
    context: context as never,
    sessionID: "root",
    rootSessionID: () => "root",
    root: () => ({ keptSubagents: {} }) as never,
    subagentLimit: () => 1,
    directSubagents: () => {
      if (fail) throw new Error("list down")
      return children as never
    },
    tree: () => undefined,
    flagshipLimit: () => 0,
  })

  await actions.evictExcessSubagents()
  expect(toasts.at(-1)).toBe("自动淘汰失败：list down")
  expect(removed).toEqual([])

  fail = false
  await actions.evictExcessSubagents()
  expect(removed).toEqual(["old"])
})