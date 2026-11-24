import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  CRITIC_TITLE_PREFIX,
  buildCriticPrompt,
  criticReview,
  isCriticSession,
  lastAssistantText,
  messageText,
  parseCriticVerdict,
  summarizeSessionRecord,
  type CriticClient,
  type CriticSessionInfo,
} from "./critic"

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true })
  }
})

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "critic-plugin-"))
  cleanups.push(dir)
  return dir
}

type MockOptions = {
  childSession?: CriticSessionInfo
  answer?: string
  createError?: Error
  neverFinishes?: boolean
}

function mockClient(options: MockOptions = {}) {
  const calls = {
    created: [] as Array<{ parentID?: string; agent?: string; title?: string }>,
    updated: [] as Array<{ sessionID: string; metadata?: Record<string, unknown> }>,
    prompted: [] as Array<{ sessionID: string; text: string }>,
    removed: [] as string[],
  }
  const child = options.childSession ?? { id: "child-1", title: "修复登录" }
  const answer = options.answer ?? "verdict: 一致\ndifferences:\n- 无"

  const client = {
    session: {
      async create(input: { parentID?: string; agent?: string; title?: string }) {
        if (options.createError) throw options.createError
        calls.created.push(input)
        return { id: "critic-1", title: input.title }
      },
      async get(input: { sessionID: string }) {
        if (input.sessionID === "child-1") return child
        if (options.neverFinishes) return { id: "critic-1", time: { busy: 2 } }
        return { id: "critic-1", time: { busy: 2, idle: 3 } }
      },
      async update(input: { sessionID: string; metadata?: Record<string, unknown> }) {
        calls.updated.push(input)
      },
      async prompt(input: { sessionID: string; text: string }) {
        calls.prompted.push(input)
      },
      async remove(input: { sessionID: string }) {
        calls.removed.push(input.sessionID)
      },
    },
    message: {
      async list(input: { sessionID: string }) {
        if (input.sessionID === "child-1") return { data: [] }
        return { data: [{ type: "assistant", content: [{ type: "text", text: answer }] }] }
      },
    },
  } as unknown as CriticClient

  return { client, calls }
}

describe("critic verdict parsing", () => {
  test("reads each of the four verdicts", () => {
    expect(parseCriticVerdict("verdict: 一致").verdict).toBe("一致")
    expect(parseCriticVerdict("verdict: 部分不一致").verdict).toBe("部分不一致")
    expect(parseCriticVerdict("verdict: 严重不一致").verdict).toBe("严重不一致")
    expect(parseCriticVerdict("verdict: 证据不足").verdict).toBe("证据不足")
  })

  test("an unlabelled 不一致 is not read as 一致", () => {
    expect(parseCriticVerdict("报告与实际不一致").verdict).toBe("证据不足")
  })

  test("collects the differences", () => {
    const parsed = parseCriticVerdict("verdict: 部分不一致\ndifferences:\n- 记录里没有写操作")
    expect(parsed.differences).toEqual(["记录里没有写操作"])
  })
})

describe("critic message text", () => {
  test("uses only the formal text when reasoning and tool parts precede the report", () => {
    const report = "verdict: 一致\ndifferences:\n- 无"
    const message = {
      type: "assistant",
      content: [
        { type: "reasoning", text: "verdict: 严重不一致\ndifferences:\n- 推理草稿" },
        { type: "tool", text: "verdict: 证据不足", state: { output: "工具正文" } },
        { type: "text", text: report },
      ],
    }

    expect(messageText(message)).toBe(report)
    expect(lastAssistantText([message])).toBe(report)
  })

  test("keeps direct message text and text parts compatible", () => {
    const message = {
      role: "assistant",
      text: "verdict: 部分不一致",
      parts: [{ type: "reasoning", text: "内部推理" }, { type: "text", text: "differences:\n- 真实差异" }],
    }

    expect(messageText(message)).toBe("verdict: 部分不一致\ndifferences:\n- 真实差异")
    expect(lastAssistantText([message])).toBe("verdict: 部分不一致\ndifferences:\n- 真实差异")
  })
})

describe("critic session record", () => {
  test("summarizes shell and tool input, status, exit code, error and output", () => {
    const record = summarizeSessionRecord([
      { command: "bun test critic.test.ts", exit: 0 },
      {
        content: [
          {
            type: "tool",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "bun test critic.test.ts" },
              output: "10 pass",
              metadata: { exitCode: 0 },
            },
          },
        ],
      },
      {
        parts: [
          {
            type: "tool",
            tool: "read",
            input: { filePath: "src/a.ts" },
            status: "error",
            error: { message: "permission denied" },
            output: "partial output",
          },
          {
            type: "tool",
            name: "legacy-shell",
            state: {
              status: "completed",
              input: { command: "legacy" },
              content: [
                { type: "reasoning", text: "not tool output" },
                { type: "text", text: "content output" },
              ],
              metadata: { exit: 1 },
            },
          },
        ],
      },
    ])
    const lines = record.split("\n")

    expect(lines[0]).toBe("[shell] bun test critic.test.ts exit=0")
    expect(lines[1]).toContain("command=bun test critic.test.ts")
    expect(lines[1]).toContain("status=completed")
    expect(lines[1]).toContain("exit=0")
    expect(lines[1]).toContain("output=10 pass")
    expect(lines[1]).not.toContain("error=")
    expect(lines[2]).toContain("[tool:read] filePath=src/a.ts")
    expect(lines[2]).toContain("status=error")
    expect(lines[2]).toContain("error=permission denied")
    expect(lines[2]).toContain("output=partial output")
    expect(lines[3]).toContain("output=content output")
    expect(lines[3]).toContain("exit=1")
    expect(lines[3]).not.toContain("not tool output")
  })

  test("does not invent execution fields that are absent", () => {
    const record = summarizeSessionRecord([
      { parts: [{ type: "tool", name: "read", state: { input: { filePath: "src/a.ts" } } }] },
    ])

    expect(record).toBe("[tool:read] filePath=src/a.ts")
    expect(record).not.toContain("undefined")
    expect(record).not.toContain("status=")
    expect(record).not.toContain("exit=")
    expect(record).not.toContain("error=")
    expect(record).not.toContain("output=")
  })

  test("bounds each output and the complete record", () => {
    const output = summarizeSessionRecord([
      { parts: [{ type: "tool", name: "shell", state: { output: "x".repeat(2000) } }] },
    ])
    const summary = /output=(.*)$/.exec(output)?.[1]

    expect(summary).toHaveLength(600)
    expect(summary?.endsWith("…[截断]")).toBe(true)

    const many = summarizeSessionRecord(
      Array.from({ length: 220 }, (_, index) => ({
        parts: [{ type: "tool", name: `tool-${index}`, state: { output: "y".repeat(2000) } }],
      })),
    )
    expect(many.length).toBeLessThanOrEqual(60_000)
    expect(many.split("\n").length).toBeLessThanOrEqual(200)
    expect(many).toContain("…[截断]")

    const linesOnly = summarizeSessionRecord(
      Array.from({ length: 220 }, (_, index) => ({ command: `command-${index}`, exit: 0 })),
    )
    expect(linesOnly.split("\n")).toHaveLength(200)
    expect(linesOnly).toContain("后续工具记录已截断")
  })
})

describe("critic prompt evidence rules", () => {
  test("empty records cannot imply non-execution, while real conflicts still count", () => {
    const prompt = buildCriticPrompt({ reportText: "测试通过", record: "", files: [] })

    expect(prompt).toContain("未从宿主消息提取到工具记录，不代表命令未执行")
    expect(prompt).toContain("相关事项只能判为证据不足")
    expect(prompt).toContain("不得据此断言命令未执行、文件未读取或报告虚假")
    expect(prompt).toContain("有真实记录与报告直接矛盾时")
    expect(prompt).toContain("部分不一致或严重不一致")

    const conflict = parseCriticVerdict("verdict: 部分不一致\ndifferences:\n- 记录 exit=1，与报告测试通过矛盾")
    expect(conflict.verdict).toBe("部分不一致")
    expect(conflict.differences).toEqual(["记录 exit=1，与报告测试通过矛盾"])
  })
})

describe("critic session identity", () => {
  test("只有 marker 才是复核身份，标题前缀不作依据", () => {
    expect(isCriticSession({ metadata: { "superagent.critic": true } })).toBe(true)
    expect(isCriticSession({ title: `${CRITIC_TITLE_PREFIX}x` })).toBe(false)
    expect(isCriticSession({ title: "普通会话" })).toBe(false)
    expect(isCriticSession({ metadata: { "superagent.critic": "true" } })).toBe(false)
    expect(isCriticSession(undefined)).toBe(false)
  })
})

describe("critic review", () => {
  test("a critic session reviews the report and is deleted afterwards", async () => {
    const auditDir = await tempDir()
    const mock = mockClient()

    const result = await criticReview(
      { client: mock.client, childSessionID: "child-1", rootID: "root-1", reportText: "我改了 src/a.ts" },
      { auditDir },
    )

    expect(result.verdict).toBe("一致")
    expect(mock.calls.created[0]!.agent).toBe("explore")
    expect(mock.calls.created[0]!.parentID).toBe("root-1")
    expect(mock.calls.updated[0]!.metadata?.["superagent.critic"]).toBe(true)
    expect(mock.calls.prompted[0]!.text).toContain("我改了 src/a.ts")
    expect(mock.calls.removed).toEqual(["critic-1"])
  })

  test("a critic session is never reviewed again", async () => {
    const auditDir = await tempDir()
    const mock = mockClient({
      childSession: { id: "child-1", title: "修复登录", metadata: { "superagent.critic": true } },
    })

    const result = await criticReview(
      { client: mock.client, childSessionID: "child-1", rootID: "root-1", reportText: "报告" },
      { auditDir },
    )

    expect(result.skipped).toBe(true)
    expect(mock.calls.created).toHaveLength(0)
  })

  test("a failed create degrades to 证据不足", async () => {
    const auditDir = await tempDir()
    const mock = mockClient({ createError: new Error("server is down") })

    const result = await criticReview(
      { client: mock.client, childSessionID: "child-1", rootID: "root-1", reportText: "报告" },
      { auditDir },
    )

    expect(result.verdict).toBe("证据不足")
  })

  test("a timeout degrades to 证据不足", async () => {
    const auditDir = await tempDir()
    const mock = mockClient({ neverFinishes: true })

    const result = await criticReview(
      { client: mock.client, childSessionID: "child-1", rootID: "root-1", reportText: "报告" },
      { auditDir, timeoutMs: 20, pollIntervalMs: 5 },
    )

    expect(result.verdict).toBe("证据不足")
    expect(mock.calls.removed).toEqual(["critic-1"])
  })

  test("abort stops the completion poll and still removes the critic session", async () => {
    const auditDir = await tempDir()
    const mock = mockClient({ neverFinishes: true })
    const controller = new AbortController()
    const started = Date.now()
    const review = criticReview(
      { client: mock.client, childSessionID: "child-1", rootID: "root-1", reportText: "报告" },
      { auditDir, timeoutMs: 500, pollIntervalMs: 10, signal: controller.signal },
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort(new Error("plugin disposed"))
    const result = await review

    expect(result.verdict).toBe("证据不足")
    expect(Date.now() - started).toBeLessThan(400)
    expect(mock.calls.removed).toEqual(["critic-1"])
  })

  test("the audit row carries the child session, the verdict and the duration", async () => {
    const auditDir = await tempDir()
    const mock = mockClient({ answer: "verdict: 严重不一致\ndifferences:\n- 报告造假" })

    const result = await criticReview(
      { client: mock.client, childSessionID: "child-1", rootID: "root-1", reportText: "报告" },
      { auditDir },
    )

    const raw = await readFile(result.auditPath, "utf8")
    const row = JSON.parse(raw.trim().split("\n").pop()!)
    expect(row.childSessionID).toBe("child-1")
    expect(row.verdict).toBe("严重不一致")
    expect(row.differences).toEqual(["报告造假"])
    expect(typeof row.durationMs).toBe("number")
  })

  test("审计目录认 SUPERERAGENT_STATE_DIR：与监管审计、面板读取同一份状态根", async () => {
    const stateDir = await tempDir()
    const previous = process.env.SUPERAGENT_STATE_DIR
    process.env.SUPERAGENT_STATE_DIR = stateDir
    try {
      const mock = mockClient()

      const result = await criticReview(
        { client: mock.client, childSessionID: "child-1", rootID: "root-1", reportText: "报告" },
      )

      expect(path.dirname(result.auditPath)).toBe(path.join(stateDir, "critic"))
      expect(path.basename(result.auditPath)).toBe(`${new Date().toISOString().slice(0, 10)}.jsonl`)
      const raw = await readFile(result.auditPath, "utf8")
      expect(raw.trim().length).toBeGreaterThan(0)
    } finally {
      if (previous === undefined) delete process.env.SUPERAGENT_STATE_DIR
      else process.env.SUPERAGENT_STATE_DIR = previous
    }
  })
})
