import { describe, expect, test } from "bun:test"
import {
  buildHandoffSummary,
  extractStatusLines,
  HANDOFF_LIMIT,
  truncateHandoff,
  type HandoffClient,
} from "./handoff"

const report = [
  "状态：progress",
  "需人决定：无",
  "报告时间：2026-01-01T00:00:00Z",
  "",
  "改动：src/a.ts — 加导出；src/b.ts — 修测试",
  "测试：命令 + 结果明细：bun test 通过",
  "风险：还需补 README",
].join("\n")

function mockClient(
  options: {
    title?: string
    messages?: unknown[]
    listError?: Error
    getError?: Error
  } = {},
): HandoffClient {
  return {
    session: {
      async get() {
        if (options.getError) throw options.getError
        return { title: options.title ?? "实现登录" }
      },
    },
    message: {
      async list() {
        if (options.listError) throw options.listError
        return (
          options.messages ?? [
            { type: "user", text: "做登录" },
            { type: "assistant", content: [{ type: "text", text: report }] },
          ]
        )
      },
    },
  }
}

describe("handoff summary", () => {
  test("extracts the last report, its status lines, changes and leftovers", async () => {
    const summary = await buildHandoffSummary({
      client: mockClient({
        messages: [
          { type: "user", text: "做登录" },
          { type: "assistant", content: [{ type: "text", text: report }] },
          { type: "assistant", text: "继续补测试，稍后汇报" },
        ],
      }),
      childSessionID: "ses_child",
    })

    expect(summary.split("\n")[0]).toBe("# 交接：实现登录")
    expect(summary).toContain("\n状态：progress；需人决定：无；报告时间：2026-01-01T00:00:00Z\n")
    expect(summary).not.toContain("状态：状态：")
    expect(summary).toContain("已完成：src/a.ts — 加导出；src/b.ts — 修测试")
    expect(summary).toContain("剩余：还需补 README")
    expect(summary).toContain("关键指针：src/a.ts、src/b.ts；原会话 ses_child")
    expect(summary).toContain("Superagent 可翻查完整记录")
    expect(summary.length).toBeLessThanOrEqual(HANDOFF_LIMIT)
  })

  test("falls back to a minimal summary when there is no report", async () => {
    const summary = await buildHandoffSummary({
      client: mockClient({
        messages: [
          { type: "user", text: "做登录" },
          { type: "assistant", text: "我先看一下代码" },
        ],
      }),
      childSessionID: "ses_child",
    })

    expect(summary).toContain("# 交接：实现登录")
    expect(summary).toContain("状态：未报告")
    expect(summary).toContain("已完成：见会话记录")
    expect(summary).toContain("剩余：见会话记录")
    expect(summary).toContain("原会话 ses_child")
    expect(summary).toContain("翻查完整记录")
  })

  test("compresses an overlong report under the hard cap", async () => {
    const long = [
      "状态：ready",
      "需人决定：无",
      "报告时间：2026-01-01T00:00:00Z",
      `改动：src/x.ts — ${"细节".repeat(900)}`,
      "风险：等待评审",
    ].join("\n")

    const summary = await buildHandoffSummary({
      client: mockClient({ messages: [{ type: "assistant", text: long }] }),
      childSessionID: "ses_child",
    })

    expect(summary.length).toBeLessThanOrEqual(HANDOFF_LIMIT)
    expect(summary).toContain("状态：ready")
    expect(summary).toContain("剩余：等待评审")
    expect(summary).toContain("已压缩，见原会话记录")
    expect(summary).toContain("原会话 ses_child")
  })

  test("never throws when the session or message API fails", async () => {
    const listFailure = await buildHandoffSummary({
      client: mockClient({ listError: new Error("message.list down") }),
      childSessionID: "ses_child",
    })
    expect(listFailure).toContain("# 交接：实现登录")
    expect(listFailure).toContain("状态：未报告")
    expect(listFailure).toContain("原会话 ses_child")

    const getFailure = await buildHandoffSummary({
      client: mockClient({ getError: new Error("session.get down"), listError: new Error("message.list down") }),
      childSessionID: "ses_child",
    })
    expect(getFailure).toContain("# 交接：未命名会话")
    expect(getFailure).toContain("原会话 ses_child")
  })

  test("exports the status extractor and the truncation helper", () => {
    expect(extractStatusLines(report)).toEqual([
      "状态：progress",
      "需人决定：无",
      "报告时间：2026-01-01T00:00:00Z",
    ])
    expect(extractStatusLines("没有报告头")).toEqual([])

    const long = truncateHandoff(
      {
        title: "任务",
        status: "ready",
        completed: "改动".repeat(5000),
        remaining: "剩余".repeat(5000),
        pointers: "原会话 ses_x（Superagent 可翻查完整记录）",
      },
      HANDOFF_LIMIT,
    )
    expect(long.length).toBeLessThanOrEqual(HANDOFF_LIMIT)
    expect(long).toContain("状态：ready")
    expect(long).toContain("原会话 ses_x")
    expect(long).toContain("已压缩，见原会话记录")
  })
})