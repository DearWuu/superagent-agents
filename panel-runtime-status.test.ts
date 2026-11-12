/**
 * 面板运行状态派生：后台任务标记优先于结束结果，运行中仍然显示进行中。
 */
import { describe, expect, test } from "bun:test"

import { runtimeStatusView, sessionStatusView } from "./run-duration"

const NOW = 1_800_000_000_000

function runtimeMetadata(jobs: unknown[]) {
  return { "superagent.runtime": { state: "idle-background", at: NOW, background: jobs } }
}

describe("runtimeStatusView", () => {
  test("后台任务标记显示后台任务数", () => {
    expect(
      runtimeStatusView(runtimeMetadata([{ kind: "shell", id: "sh_1", command: "npm run dev" }])),
    ).toEqual({ glyph: "⏳", text: "后台 1 个任务", longRunning: false })
  })

  test("多个后台任务按数量显示", () => {
    const view = runtimeStatusView(
      runtimeMetadata([
        { kind: "shell", id: "sh_1", command: "a" },
        { kind: "subagent", id: "ses_x", command: "b" },
      ]),
    )
    expect(view?.text).toBe("后台 2 个任务")
  })

  test("没有标记或标记非法时返回 undefined", () => {
    expect(runtimeStatusView(undefined)).toBeUndefined()
    expect(runtimeStatusView({})).toBeUndefined()
    expect(runtimeStatusView({ "superagent.runtime": "x" })).toBeUndefined()
    expect(runtimeStatusView({ "superagent.runtime": { state: "completed" } })).toBeUndefined()
    expect(runtimeStatusView({ "superagent.runtime": { state: "idle-background" } })).toBeUndefined()
  })
})

describe("sessionStatusView 与运行状态标记", () => {
  test("会话不在运行且有后台标记：优先显示后台任务", () => {
    const view = sessionStatusView(
      { outcome: "succeeded", time: { busy: NOW - 60_000, idle: NOW }, metadata: runtimeMetadata([{ kind: "shell" }]) },
      false,
      { now: NOW, duration: true },
    )
    expect(view).toEqual({ glyph: "⏳", text: "后台 1 个任务", longRunning: false })
  })

  test("运行中仍然显示进行中", () => {
    const view = sessionStatusView(
      { outcome: "succeeded", time: { busy: NOW - 60_000 }, metadata: runtimeMetadata([{ kind: "shell" }]) },
      true,
      { now: NOW, duration: true },
    )
    expect(view.text).toBe("进行中 1m")
  })

  test("没有后台标记时按结束结果显示", () => {
    const view = sessionStatusView(
      { outcome: "succeeded", time: { busy: NOW - 60_000, idle: NOW } },
      false,
      { now: NOW, duration: true },
    )
    expect(view).toEqual({ glyph: "✓", text: "已完成", longRunning: false })
  })
})
