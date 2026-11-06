import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  CRITIC_TITLE_PREFIX,
  criticReview,
  isCriticSession,
  parseCriticVerdict,
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

describe("critic session identity", () => {
  test("a marker identifies a critic session", () => {
    expect(isCriticSession({ metadata: { "superagent.critic": true } })).toBe(true)
    expect(isCriticSession({ title: `${CRITIC_TITLE_PREFIX}x` })).toBe(true)
    expect(isCriticSession({ title: "普通会话" })).toBe(false)
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
    const mock = mockClient({ childSession: { id: "child-1", title: `${CRITIC_TITLE_PREFIX}修复登录` } })

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
})
