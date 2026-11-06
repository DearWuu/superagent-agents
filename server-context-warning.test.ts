/**
 * 超长上下文提醒：阈值、跳过条件、每子代理一次、compact 后再提醒、发送失败容错，
 * 以及真实 `setup()` 接线后向 root 发 steer 提醒的隔离实测。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import plugin, {
  CONTEXT_WARN_TOKENS,
  claimContextWarning,
  clearContextClaim,
  contextDropped,
  contextTokens,
  createCtxWarningScanner,
  ctxWarningText,
  isContextOverLimit,
  readContextClaim,
  shouldCheckContext,
} from "./server"

const NOW = 1_800_000_000_000

const usage = (input: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output: 9_999,
  reasoning: 9_999,
  cache: { read: cacheRead, write: cacheWrite },
})

const assistant = (input: number) => ({ type: "assistant", tokens: usage(input) })

const child = (overrides: Record<string, unknown> = {}) => ({
  id: "ses_child",
  title: "修复登录",
  ...overrides,
})

type ScannerOptions = {
  candidates: any[]
  tokens?: Record<string, number | undefined>
  roots?: Record<string, string>
  configured?: boolean
  claim?: (sessionID: string, tokens: number) => boolean
  rootIsEnabled?: (rootID: string) => Promise<boolean>
  sendError?: boolean
}

function scannerHarness(options: ScannerOptions) {
  const prompts: Array<{ sessionID: string; text: string }> = []
  const logs: any[] = []
  const scanner = createCtxWarningScanner({
    listSessions: async () => options.candidates,
    resolveRoot: async (sessionID) => options.roots?.[sessionID] ?? "ses_root",
    rootIsConfigured: async () => options.configured ?? true,
    readTokens: async (sessionID) => options.tokens?.[sessionID],
    sendWarn: async (sessionID, text) => {
      if (options.sendError) throw new Error("steer down")
      prompts.push({ sessionID, text })
    },
    claim: options.claim ?? (() => true),
    rootIsEnabled: options.rootIsEnabled,
    log: (record) => logs.push(record),
    now: () => NOW,
  })
  return { scanner, prompts, logs }
}

const cleanups: string[] = []

function tempState() {
  const dir = mkdtempSync(path.join(tmpdir(), "superagent-ctx-"))
  cleanups.push(dir)
  process.env.SUPERAGENT_STATE_DIR = dir
  process.env.SUPERAGENT_HOOK_LOG = path.join(dir, "hook.log")
  process.env.XDG_CONFIG_HOME = dir
  return dir
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
  delete process.env.SUPERAGENT_STATE_DIR
  delete process.env.SUPERAGENT_HOOK_LOG
  delete process.env.XDG_CONFIG_HOME
})

beforeEach(() => {
  tempState()
})

describe("contextTokens（与面板同口径）", () => {
  test("取最近一次 assistant 调用的输入，含 cache 读写、不含输出", () => {
    expect(contextTokens([assistant(80_000), assistant(12_000)])).toBe(12_000)
    expect(contextTokens([{ type: "assistant", tokens: usage(20_000, 10_000, 2_000) }])).toBe(32_000)
  })

  test("跳过已完成的 compact 之前的旧记录", () => {
    const messages = [
      assistant(150_000),
      { type: "compaction", status: "completed", tokens: usage(150_000) },
      assistant(18_000),
    ]
    expect(contextTokens(messages)).toBe(18_000)
    expect(contextTokens(messages.slice(0, 2))).toBeUndefined()
  })

  test("最近一条不是 assistant 时回退到更早带 usage 的记录", () => {
    expect(contextTokens([assistant(32_000), { type: "user", text: "继续" }])).toBe(32_000)
  })

  test("无数据、零输入返回 undefined", () => {
    expect(contextTokens(undefined)).toBeUndefined()
    expect(contextTokens([])).toBeUndefined()
    expect(contextTokens([assistant(0)])).toBeUndefined()
  })
})

describe("阈值与下降判定", () => {
  test("299k 不触发、301k 触发（严格大于 300k）", () => {
    expect(CONTEXT_WARN_TOKENS).toBe(300_000)
    expect(isContextOverLimit(299_000)).toBe(false)
    expect(isContextOverLimit(300_000)).toBe(false)
    expect(isContextOverLimit(301_000)).toBe(true)
    expect(isContextOverLimit(undefined)).toBe(false)
  })

  test("下降 ≥30% 视为 compact 过", () => {
    expect(contextDropped(350_000, 245_000)).toBe(true)
    expect(contextDropped(350_000, 244_999)).toBe(true)
    expect(contextDropped(350_000, 246_000)).toBe(false)
    expect(contextDropped(undefined, 100_000)).toBe(false)
  })

  test("提醒文案指向子代理并给出两条处置路径", () => {
    expect(ctxWarningText("修复登录", "ses_child", 301_400)).toBe(
      "[上下文提醒] 子代理「修复登录」(ses_child) 当前上下文约 301k tokens（>300k）。建议：对其执行 compact，或删除重建（可用交接摘要续接）。",
    )
    expect(ctxWarningText("  ", "ses_child", 350_000)).toContain("「未命名」")
  })
})

describe("shouldCheckContext 跳过条件", () => {
  test("root 由扫描器跳过；critic 与已结束会话在这里跳过", () => {
    expect(shouldCheckContext(child())).toBe(true)
    expect(shouldCheckContext(child({ title: "Critic: 复核 x", metadata: { "superagent.critic": true } }))).toBe(false)
    expect(
      shouldCheckContext(child({ outcome: "succeeded", busy: NOW - 2_000, idle: NOW - 1_000 })),
    ).toBe(false)
  })

  test("有 outcome 但仍在运行（被重新 steer）不跳过", () => {
    expect(
      shouldCheckContext(child({ outcome: "succeeded", busy: NOW - 500, idle: NOW - 1_000 })),
    ).toBe(true)
  })
})

describe("createCtxWarningScanner", () => {
  test("root 停用时跳过该 root，但整轮仍列会话（不按全局布尔整轮跳过）", async () => {
    let listed = 0
    const prompts: any[] = []
    const scanner = createCtxWarningScanner({
      listSessions: async () => {
        listed += 1
        return [child({ time: { busy: NOW - 500 } })]
      },
      resolveRoot: async () => "ses_root",
      rootIsEnabled: async () => false,
      rootIsConfigured: async () => true,
      readTokens: async () => 400_000,
      sendWarn: async (root, text) => prompts.push({ root, text }),
      log: () => {},
    })
    expect(await scanner.scan()).toBe(0)
    expect(listed).toBe(1)
    expect(prompts).toHaveLength(0)
  })

  test("root 自身、critic 会话、已结束会话都不检查", async () => {
    const { scanner, prompts } = scannerHarness({
      candidates: [
        child({ id: "ses_root" }),
        child({ id: "ses_critic", title: "Critic: 复核 x", metadata: { "superagent.critic": true } }),
        child({ id: "ses_done", outcome: "succeeded", busy: NOW - 2_000, idle: NOW - 1_000 }),
      ],
      roots: { ses_root: "ses_root" },
      tokens: { ses_root: 400_000, ses_critic: 400_000, ses_done: 400_000 },
    })
    expect(await scanner.scan()).toBe(0)
    expect(prompts).toHaveLength(0)
  })

  test("root 没有 superagent 配置时不检查", async () => {
    const { scanner, prompts } = scannerHarness({
      candidates: [child()],
      tokens: { ses_child: 400_000 },
      configured: false,
    })
    expect(await scanner.scan()).toBe(0)
    expect(prompts).toHaveLength(0)
  })

  test("超过阈值向 root 发 steer，内容正确", async () => {
    const { scanner, prompts, logs } = scannerHarness({
      candidates: [child({ time: { busy: NOW - 500 } })],
      tokens: { ses_child: 350_000 },
    })
    expect(await scanner.scan()).toBe(1)
    expect(prompts).toEqual([
      { sessionID: "ses_root", text: ctxWarningText("修复登录", "ses_child", 350_000) },
    ])
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "ctx-warn", childSessionID: "ses_child", tokens: 350_000, root: "ses_root" }),
    )
  })

  test("每个子会话只提醒一次（落盘声明跨实例生效）", async () => {
    const options = {
      candidates: [child({ time: { busy: NOW - 500 } })],
      tokens: { ses_child: 350_000 },
      claim: claimContextWarning,
    }
    const first = scannerHarness(options)
    expect(await first.scanner.scan()).toBe(1)
    expect(readContextClaim("ses_child")).toBe(350_000)

    // 换一个扫描器实例（模拟 reload 后的新插件）：声明还在，不再提醒。
    const second = scannerHarness(options)
    expect(await second.scanner.scan()).toBe(0)
    expect(second.prompts).toHaveLength(0)
  })

  test("compact 后（下降 ≥30%）清声明，再次超阈时允许再提醒", async () => {
    const tokens: Record<string, number | undefined> = { ses_child: 350_000 }
    const { scanner, prompts } = scannerHarness({
      candidates: [child({ time: { busy: NOW - 500 } })],
      tokens,
      claim: claimContextWarning,
    })
    expect(await scanner.scan()).toBe(1)

    // compact 后长度降到 200k：本轮不提醒，但声明被清掉。
    tokens.ses_child = 200_000
    expect(await scanner.scan()).toBe(0)
    expect(readContextClaim("ses_child")).toBeUndefined()

    // 又涨回 320k：重新提醒一次。
    tokens.ses_child = 320_000
    expect(await scanner.scan()).toBe(1)
    expect(prompts.map((prompt) => prompt.sessionID)).toEqual(["ses_root", "ses_root"])
    expect(prompts[1]!.text).toContain("约 320k tokens")
  })

  test("声明文件被手动清掉后可再次提醒", async () => {
    const options = { candidates: [child({ time: { busy: NOW - 500 } })], tokens: { ses_child: 350_000 } }
    const first = scannerHarness(options)
    expect(await first.scanner.scan()).toBe(1)
    clearContextClaim("ses_child")
    expect(await first.scanner.scan()).toBe(1)
  })

  test("发送失败只记日志、不抛出；声明保留，下一轮不重复轰炸", async () => {
    const { scanner, prompts, logs } = scannerHarness({
      candidates: [child({ time: { busy: NOW - 500 } })],
      tokens: { ses_child: 350_000 },
      claim: claimContextWarning,
      sendError: true,
    })
    expect(await scanner.scan()).toBe(0)
    expect(prompts).toHaveLength(0)
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "ctx-warn-failed", childSessionID: "ses_child", tokens: 350_000, root: "ses_root" }),
    )
    expect(await scanner.scan()).toBe(0)
    expect(logs.filter((record) => record.event === "ctx-warn-failed")).toHaveLength(1)
  })
})

describe("真实 setup 接线（假 ctx + 捕获定时器）", () => {
  type FakeSession = {
    id: string
    parentID?: string
    title?: string
    outcome?: string | null
    time?: { created?: number; busy?: number; idle?: number; archived?: number }
    metadata?: Record<string, unknown>
  }

  function harness(sessions: FakeSession[], messages: Record<string, any[]>) {
    const prompts: Array<{ sessionID: string; text: string; delivery?: string }> = []
    const events: any[] = []
    const ctx = {
      tool: { hook: async () => ({ dispose() {} }) },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield event
          },
        }),
      },
      session: {
        hook: async () => ({ dispose() {} }),
        async get({ sessionID }: { sessionID: string }) {
          const found = sessions.find((session) => session.id === sessionID)
          if (!found) throw new Error(`no session ${sessionID}`)
          return { ...found, time: { ...(found.time ?? {}) } }
        },
        async list() {
          return { data: sessions.map((session) => ({ ...session, time: { ...(session.time ?? {}) } })) }
        },
        async context({ sessionID }: { sessionID: string }) {
          return messages[sessionID] ?? []
        },
        async prompt(input: { sessionID: string; text: string; delivery?: string }) {
          prompts.push(input)
          return { id: `msg_${prompts.length}` }
        },
        async create() {
          return {}
        },
        async update() {},
        async remove() {},
        async switchModel() {},
        instructions: {
          entry: {
            list: async () => [{ key: "superagent.max-subagents", value: 5 }],
            put: async () => {},
            remove: async () => {},
          },
        },
      },
    }
    return { ctx, prompts }
  }

  function readJsonl(file: string): any[] {
    try {
      return readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }

  async function waitFor(check: () => boolean, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return true
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return check()
  }

  test("扫描周期向 root 发提醒、内容正确且只发一次，并落 ctx-warn 日志", async () => {
    const h = harness(
      [
        { id: "ses_root", title: "root" },
        { id: "ses_child", parentID: "ses_root", title: "修复登录", time: { created: NOW - 1_000, busy: NOW - 500 } },
      ],
      { ses_child: [assistant(350_000)] },
    )

    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    let handler: (() => void) | undefined
    globalThis.setInterval = ((fn: any) => {
      handler = fn
      return "probe-handle" as any
    }) as any
    globalThis.clearInterval = (() => {}) as any
    let dispose: any
    try {
      dispose = await (plugin as any).setup(h.ctx)
      expect(handler).toBeDefined()
      handler!()
      expect(await waitFor(() => h.prompts.length > 0)).toBe(true)
      expect(await waitFor(() => h.prompts.length === 1)).toBe(true)

      expect(h.prompts).toEqual([
        {
          sessionID: "ses_root",
          text: ctxWarningText("修复登录", "ses_child", 350_000),
          delivery: "steer",
        },
      ])

      // 同一个 handler 再扫一轮：声明已落盘，不重复提醒。
      handler!()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(h.prompts).toHaveLength(1)

      const hookLog = readJsonl(process.env.SUPERAGENT_HOOK_LOG!)
      expect(hookLog).toContainEqual(
        expect.objectContaining({ event: "ctx-warn", childSessionID: "ses_child", tokens: 350_000, root: "ses_root" }),
      )
    } finally {
      await dispose?.()
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
  })

  test("子会话上下文未超阈值时不提醒", async () => {
    const h = harness(
      [{ id: "ses_root" }, { id: "ses_child", parentID: "ses_root", time: { busy: NOW - 500 } }],
      { ses_child: [assistant(299_000)] },
    )
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    let handler: (() => void) | undefined
    globalThis.setInterval = ((fn: any) => {
      handler = fn
      return "probe-handle" as any
    }) as any
    globalThis.clearInterval = (() => {}) as any
    let dispose: any
    try {
      dispose = await (plugin as any).setup(h.ctx)
      handler!()
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(h.prompts).toHaveLength(0)
    } finally {
      await dispose?.()
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
  })
})