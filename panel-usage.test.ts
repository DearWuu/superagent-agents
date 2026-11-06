/** @jsxImportSource @opentui/solid */
/**
 * 信息行上下文读数与监管等级介绍：都是纯格式化逻辑，直接锁住文案与阈值。
 */
import { describe, expect, test, mock } from "bun:test"

mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (value: unknown) => value } }))
const tui = await import("./index")

const usage = (input: number, output = 0) => ({
  input,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

const assistant = (input: number) => ({ type: "assistant", tokens: usage(input) })

describe("formatTokenCount", () => {
  test("千位以下按原数显示", () => {
    expect(tui.formatTokenCount(0)).toBe("")
    expect(tui.formatTokenCount(1)).toBe("1")
    expect(tui.formatTokenCount(950)).toBe("950")
  })

  test("千位区间保留一位小数，整数不带 .0", () => {
    expect(tui.formatTokenCount(1_000)).toBe("1k")
    expect(tui.formatTokenCount(1_200)).toBe("1.2k")
    expect(tui.formatTokenCount(32_000)).toBe("32k")
    expect(tui.formatTokenCount(99_900)).toBe("99.9k")
  })

  test("十万以上取整，百万以上带 m", () => {
    expect(tui.formatTokenCount(100_000)).toBe("100k")
    expect(tui.formatTokenCount(125_600)).toBe("126k")
    expect(tui.formatTokenCount(1_200_000)).toBe("1.2m")
  })

  test("非法数值不显示", () => {
    expect(tui.formatTokenCount(Number.NaN)).toBe("")
    expect(tui.formatTokenCount(-1)).toBe("")
  })
})

describe("contextTokens", () => {
  test("取最近一次 assistant 调用的输入规模，不是累计成本", () => {
    expect(tui.contextTokens([assistant(80_000), assistant(12_000)])).toBe(12_000)
  })

  test("输入口径包含 cache 读写，不含输出", () => {
    const message = {
      type: "assistant",
      tokens: { input: 20_000, output: 9_999, reasoning: 9_999, cache: { read: 10_000, write: 2_000 } },
    }
    expect(tui.contextTokens([message])).toBe(32_000)
  })

  test("compact 之后取新一步的输入，读数下降", () => {
    const messages = [
      assistant(150_000),
      { type: "compaction", status: "completed", tokens: usage(150_000) },
      assistant(18_000),
    ]
    expect(tui.contextTokens(messages)).toBe(18_000)
    // 还没有新一步时宁可不显示，也不拿 compact 之前的旧读数。
    expect(tui.contextTokens(messages.slice(0, 2))).toBeUndefined()
  })

  test("最近一条没有 usage 时回退到更早带 usage 的记录", () => {
    expect(tui.contextTokens([assistant(32_000), { type: "user", text: "继续" }])).toBe(32_000)
  })

  test("无数据或零输入不显示该段", () => {
    expect(tui.contextTokens(undefined)).toBeUndefined()
    expect(tui.contextTokens([])).toBeUndefined()
    expect(tui.contextTokens([assistant(0)])).toBeUndefined()
  })
})

describe("contextUsageView", () => {
  test("紧凑格式带 ctx 前缀", () => {
    expect(tui.contextUsageView([assistant(32_000)])).toEqual({ tokens: 32_000, text: "ctx 32k", warning: false })
  })

  test("严格超过 300k 才警示：299k/300k 不警示，300001/301k 警示", () => {
    expect(tui.CONTEXT_WARN_TOKENS).toBe(300_000)
    expect(tui.contextUsageView([assistant(299_000)])).toEqual({
      tokens: 299_000,
      text: "ctx 299k",
      warning: false,
    })
    expect(tui.contextUsageView([assistant(300_000)])).toEqual({
      tokens: 300_000,
      text: "ctx 300k",
      warning: false,
    })
    expect(tui.contextUsageView([assistant(300_001)])).toEqual({
      tokens: 300_001,
      text: "ctx 300k",
      warning: true,
    })
    expect(tui.contextUsageView([assistant(301_000)])).toEqual({
      tokens: 301_000,
      text: "ctx 301k",
      warning: true,
    })
  })
})

describe("OVERSIGHT_LEVEL_DESCRIPTIONS", () => {
  test("五级都介绍管到什么程度，不再是操作说明", () => {
    expect(tui.OVERSIGHT_LEVEL_DESCRIPTIONS).toEqual({
      0: "只交结果：改动/测试/风险，完成时一次汇报",
      1: "加命令清单与阶段小结，完成时一次汇报",
      2: "加阅读记录与失败详情，证据可核查（默认）",
      3: "加完整输出与代码摘录，每阶段中途简报",
      4: "逐步汇报动机与假设，全程可审计",
    })
    for (const text of Object.values(tui.OVERSIGHT_LEVEL_DESCRIPTIONS)) {
      expect(text).not.toContain("点击固定")
    }
  })
})
describe("SUPERAGENT_DEFAULTS.sessionPrompt", () => {
  test("在「主代理不做具体实现」之后、验收之前给出派工新建与续跑规则", () => {
    const prompt = tui.SUPERAGENT_DEFAULTS.sessionPrompt
    expect(prompt).toContain("派工新建与续跑：")
    expect(prompt).toContain("一律新建 Subagent")
    expect(prompt).toContain("任务需要这些上下文则直接续跑；无必要则先 compact 再续跑")
    expect(prompt).toContain("交接摘要仅用于删除重建场景，不是续跑的前置动作")
    expect(prompt).not.toContain("则新建并附交接摘要")
    expect(prompt.indexOf("派工新建与续跑")).toBeGreaterThan(prompt.indexOf("主代理不做具体实现"))
    expect(prompt.indexOf("派工新建与续跑")).toBeLessThan(prompt.indexOf("验收："))
  })
})
