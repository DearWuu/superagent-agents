import { describe, expect, test } from "bun:test"

import {
  acceptanceForLevel,
  OVERSIGHT_ACCEPTANCE,
  oversightLevelForPin,
  renderReportProtocol,
  resolveOversight,
} from "./oversight"

const pinned = (level: number) => resolveOversight({ pins: { sessions: { child: level } }, sessionID: "child" })

describe("oversight acceptance", () => {
  test("L0-L4 keep their names, actions and critic mode", () => {
    const names = { 0: "结果验收", 1: "摘要验收", 2: "证据验收", 3: "全量验收", 4: "审计验收" } as const
    for (const level of [0, 1, 2, 3, 4] as const) {
      expect(acceptanceForLevel(level).name).toBe(names[level])
      expect(acceptanceForLevel(level).actions.length).toBeGreaterThan(0)
      expect(acceptanceForLevel(level).critic).toBe(level === 4 ? "required" : "switch")
    }
  })

  test("resolved contracts carry the acceptance of their level", () => {
    expect(resolveOversight({}).acceptance).toBe(OVERSIGHT_ACCEPTANCE[2])
    for (const level of [0, 1, 2, 3, 4] as const) expect(pinned(level).acceptance).toBe(OVERSIGHT_ACCEPTANCE[level])
  })

  test("pins keep resolving levels exactly as before", () => {
    expect(pinned(0)).toMatchObject({ level: 0, source: "pin" })
    expect(pinned(4)).toMatchObject({ level: 4, source: "pin" })
    expect(
      resolveOversight({ pins: { sessions: { child: 70 } }, sessionID: "child" }),
    ).toMatchObject({ level: 3, source: "pin" })
    for (const level of [0, 1, 2, 3, 4] as const) expect(oversightLevelForPin(level)).toBe(level)
  })

  test("the protocol shows the same acceptance semantics to root and child", () => {
    const root = resolveOversight({ pins: { global: 4 } })
    const child = resolveOversight({ pins: { sessions: { child: 4 } }, rootSessionID: "root", sessionID: "child" })
    const rootText = renderReportProtocol(root)
    const childText = renderReportProtocol(child)
    const block = (text: string) => text.slice(text.indexOf("[Superagent 验收动作"))
    expect(block(rootText)).toBe(block(childText))
    expect(childText).toContain("[Superagent 验收动作 L4 · 审计验收]")
    expect(childText).toContain("复核方式：独立 critic 强制复核")
  })

  test("L2 keeps the default evidence requirements including real screenshots", () => {
    const text = renderReportProtocol(resolveOversight({}))
    expect(text).toContain("真实输出指针")
    expect(text).toContain("真实截图")
    expect(text).toContain("复核方式：critic 复核遵循 root 的 critic 开关")
  })
})