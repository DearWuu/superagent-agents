import { describe, expect, test } from "bun:test"

import {
  acceptanceForLevel,
  OVERSIGHT_ACCEPTANCE,
  oversightLevelForPin,
  renderAcceptanceOnlyProtocol,
  renderReportOnlyProtocol,
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

  test("legacy score boundary never drops an L4 pin to L0", () => {
    expect(oversightLevelForPin(4)).toBe(4)
    expect(oversightLevelForPin(4.1)).toBe(4)
    expect(oversightLevelForPin(4.6)).toBe(4)
    expect(oversightLevelForPin(5)).toBe(0)
    expect(oversightLevelForPin(58)).toBe(2)
    expect(oversightLevelForPin(70)).toBe(3)
    expect(oversightLevelForPin(Number.NaN)).toBe(2)
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

describe("subagent reporting boundary", () => {
  test("the header asks for a Superagent decision instead of a human question", () => {
    const text = renderReportOnlyProtocol(resolveOversight({}))
    expect(text).toContain("待 Superagent 裁决：blocked 时必填，写清问题与你的建议")
    expect(text).toContain("blocked=等 Superagent 裁决或等外部条件")
    expect(text).not.toContain("需人决定")
    expect(text).not.toContain("等人或等外部条件")
  })

  test("every level carries the communication boundary and the heartbeat resume rule", () => {
    for (const level of [0, 1, 2, 3, 4] as const) {
      const text = renderReportOnlyProtocol(pinned(level), "detailed")
      expect(text).toContain("沟通边界：你是 Subagent，只向 Superagent 汇报")
      expect(text).toContain("不得用 question 等任何方式向用户提问（会被拒绝）")
      expect(text).toContain("不得派发子代理")
      expect(text).toContain("不得据此断言工具不可用")
      expect(text).toContain(
        "收到 Superagent 的续跑或[状态探针]时先一行报状态再立刻继续剩余工作，不得停在简报",
      )
    }
  })

  test("acceptance tells the Superagent to rule on blocked reports", () => {
    for (const level of [0, 1, 2, 3, 4] as const) {
      expect(renderAcceptanceOnlyProtocol(pinned(level))).toContain(
        "子代理置 blocked 并提请裁决时，由 Superagent 裁决后用续跑下达；子代理不会也无法向用户提问。",
      )
    }
  })
})

describe("report and acceptance protocol separation", () => {
  test("report-only contains child reporting requirements but no Superagent acceptance block", () => {
    const text = renderReportOnlyProtocol(resolveOversight({}), "concise")
    expect(text).toContain("报告头部固定三行")
    expect(text).toContain("状态：progress | blocked | ready | failed")
    expect(text).toContain("改动：文件清单")
    expect(text).toContain("预算（内联+指针）")
    expect(text).toContain("上下文纪律（工作过程）")
    expect(text).toContain("证据必须真实")
    expect(text).not.toContain("Superagent 验收动作")
    expect(text).not.toContain("复核方式：")
    expect(text).not.toContain("真实截图")
  })

  test("acceptance-only contains acceptance actions and critic semantics but no child report protocol", () => {
    const text = renderAcceptanceOnlyProtocol(pinned(4))
    expect(text).toContain("[Superagent 验收动作 L4 · 审计验收]")
    expect(text).toContain("独立 critic 强制复核")
    expect(text).toContain("复核方式：独立 critic 强制复核")
    expect(text).not.toContain("[报告协议")
    expect(text).not.toContain("报告头部固定三行")
    expect(text).not.toContain("状态：progress")
    expect(text).not.toContain("改动：文件清单")
    expect(text).not.toContain("预算（内联+指针）")
    expect(text).not.toContain("上下文纪律")
  })

  test("concise removes process sections while detailed retains them", () => {
    const contract = resolveOversight({})
    const concise = renderReportOnlyProtocol(contract, "concise")
    const detailed = renderReportOnlyProtocol(contract, "detailed")
    expect(concise).not.toBe(detailed)
    expect(concise.length).toBeLessThan(detailed.length)
    for (const section of ["执行：命令清单 + exit code", "阶段小结：每阶段一段", "阅读：读过的文件 path:行号 + 目的"]) {
      expect(concise).not.toContain(section)
      expect(detailed).toContain(section)
    }
    for (const text of [concise, detailed]) {
      expect(text).toContain("测试：命令 + 结果明细")
      expect(text).toContain("失败详情：失败命令的关键输出")
      expect(text).toContain("证据必须真实")
    }
  })

  test("concise never downgrades L0-L4 evidence sections and every style requires failure details", () => {
    const processPrefixes = ["执行：", "阶段小结：", "阅读："]
    for (const level of [0, 1, 2, 3, 4] as const) {
      const contract = pinned(level)
      const concise = renderReportOnlyProtocol(contract, "concise")
      const detailed = renderReportOnlyProtocol(contract, "detailed")
      for (const section of contract.sections) {
        expect(detailed).toContain(section)
        if (processPrefixes.some((prefix) => section.startsWith(prefix))) continue
        expect(concise).toContain(section)
      }
      for (const text of [concise, detailed]) {
        expect(text).toContain("失败详情：失败命令的关键输出")
        expect(text).toContain("预算（内联+指针）")
        expect(text).toContain("上下文纪律（工作过程）")
      }
    }
  })

  test("legacy combined renderer remains available and forwards report style", () => {
    const contract = resolveOversight({})
    expect(renderReportProtocol(contract, "detailed")).toBe(
      `${renderReportOnlyProtocol(contract, "detailed")}\n\n${renderAcceptanceOnlyProtocol(contract)}`,
    )
  })
})