/**
 * 接线实测：用假的插件 ctx 驱动真实的 `setup()`，验证
 *  1. `session.execution.succeeded` → 子会话复核（criticReview 被调用、审计写入）；
 *  2. 超时探针 → 注入 busy 时间戳后向子会话发 steer 文案；
 *  3. dispose 清理探针定时器。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import plugin, { createCtxProbeScanner, PROBE_AFTER_MS, PROBE_TEXT } from "./server"
import { LONG_RUNNING_THRESHOLD_MS } from "./run-duration"

const NOW = 1_800_000_000_000

type FakeSession = {
  id: string
  parentID?: string
  title?: string
  outcome?: string | null
  time?: { created?: number; busy?: number; idle?: number; archived?: number }
  metadata?: Record<string, unknown>
}

type HarnessOptions = {
  sessions: FakeSession[]
  entries?: Record<string, Array<{ key: string; value: unknown }>>
  criticAnswer?: string
  childReport?: string
}

type EventQueue = {
  push: (event: any) => void
  close: () => void
  iterable: AsyncIterable<any>
}

function eventQueue(): EventQueue {
  const buffered: any[] = []
  let notify: (() => void) | undefined
  let closed = false
  const iterable = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buffered.length > 0) {
          yield buffered.shift()
          continue
        }
        if (closed) return
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    },
  }
  return {
    iterable,
    push(event) {
      buffered.push(event)
      notify?.()
      notify = undefined
    },
    close() {
      closed = true
      notify?.()
      notify = undefined
    },
  }
}

function harness(options: HarnessOptions) {
  const sessions = new Map<string, FakeSession>()
  for (const session of options.sessions) sessions.set(session.id, { ...session })

  const prompts: Array<{ sessionID: string; text: string; delivery?: string }> = []
  const created: Array<{ parentID?: string; agent?: string; title?: string }> = []
  const updated: Array<{ sessionID: string; metadata?: Record<string, unknown> }> = []
  const removed: string[] = []
  const events = eventQueue()

  const ctx = {
    tool: {
      hook: async () => ({ dispose() {} }),
    },
    event: {
      subscribe: () => events.iterable,
    },
    session: {
      hook: async () => ({ dispose() {} }),
      async get({ sessionID }: { sessionID: string }) {
        const found = sessions.get(sessionID)
        if (!found) throw new Error(`no session ${sessionID}`)
        return { ...found, time: { ...(found.time ?? {}) } }
      },
      async list() {
        return { data: [...sessions.values()].map((session) => ({ ...session, time: { ...(session.time ?? {}) } })) }
      },
      async create(input: { parentID?: string; agent?: string; title?: string; metadata?: Record<string, unknown> }) {
        created.push(input)
        const id = "ses_critic"
        // 复核会话一创建就当作已完成：waitForCompletion 靠 busy/idle 判结束。
        sessions.set(id, {
          id,
          parentID: input.parentID,
          title: input.title,
          metadata: input.metadata,
          time: { busy: NOW, idle: NOW + 1 },
        })
        return sessions.get(id)
      },
      async update(input: { sessionID: string; metadata?: Record<string, unknown> }) {
        updated.push(input)
        const found = sessions.get(input.sessionID)
        if (found) found.metadata = input.metadata
      },
      async prompt(input: { sessionID: string; text: string; delivery?: string }) {
        prompts.push(input)
        return { id: `msg_${prompts.length}` }
      },
      async context({ sessionID }: { sessionID: string }) {
        const text = sessionID === "ses_critic" ? (options.criticAnswer ?? "verdict: 一致\ndifferences:\n- 无") : (options.childReport ?? "我改了 src/a.ts")
        return [{ id: "msg_1", type: "assistant", content: [{ type: "text", text }] }]
      },
      async remove({ sessionID }: { sessionID: string }) {
        removed.push(sessionID)
        sessions.delete(sessionID)
      },
      async switchModel() {},
      instructions: {
        entry: {
          async list({ sessionID }: { sessionID: string }) {
            return options.entries?.[sessionID] ?? []
          },
          async put() {},
          async remove() {},
        },
      },
    },
  }

  return { ctx, sessions, prompts, created, updated, removed, events }
}

const cleanups: string[] = []

function tempState() {
  const dir = mkdtempSync(path.join(tmpdir(), "superagent-wiring-"))
  cleanups.push(dir)
  process.env.SUPERAGENT_STATE_DIR = dir
  process.env.XDG_STATE_HOME = dir
  process.env.SUPERAGENT_HOOK_LOG = path.join(dir, "hook.log")
  return dir
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
  delete process.env.SUPERAGENT_STATE_DIR
  delete process.env.XDG_STATE_HOME
  delete process.env.SUPERAGENT_HOOK_LOG
})

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return check()
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

describe("critic 自动接线（真实 setup + 假 ctx）", () => {
  test("root 开 critic-enabled=true，子会话成功完成后发起复核并写审计", async () => {
    tempState()
    const h = harness({
      sessions: [
        { id: "ses_root", title: "root" },
        { id: "ses_child", parentID: "ses_root", title: "修复登录" },
      ],
      entries: {
        ses_root: [{ key: "superagent.critic-enabled", value: "true" }],
      },
    })

    const dispose = await (plugin as any).setup(h.ctx)
    h.events.push({ id: "evt_1", type: "session.execution.succeeded", data: { sessionID: "ses_child" } })

    const auditFile = path.join(process.env.XDG_STATE_HOME!, "opencode", "superagent", "critic", `${new Date().toISOString().slice(0, 10)}.jsonl`)
    expect(await waitFor(() => readJsonl(auditFile).length > 0)).toBe(true)

    // 复核会话按 root 挂载、用 explore、标题带前缀
    expect(h.created[0]!.parentID).toBe("ses_root")
    expect(h.created[0]!.agent).toBe("explore")
    expect(h.created[0]!.title).toContain("复核")
    // 报告正文被带进复核提示词
    expect(h.prompts[0]!.text).toContain("我改了 src/a.ts")
    expect(h.removed).toContain("ses_critic")

    const row = readJsonl(auditFile)[0]
    expect(row.childSessionID).toBe("ses_child")
    expect(row.verdict).toBe("一致")

    // 结果也落一条 hook.log
    const hookLog = readJsonl(process.env.SUPERAGENT_HOOK_LOG!)
    expect(hookLog.some((record) => record.event === "critic-finished" && record.childSessionID === "ses_child")).toBe(true)

    await dispose()
    h.events.close()
  })

  test("critic-enabled=false 时不复核", async () => {
    tempState()
    const h = harness({
      sessions: [
        { id: "ses_root" },
        { id: "ses_child", parentID: "ses_root" },
      ],
      entries: { ses_root: [{ key: "superagent.critic-enabled", value: "false" }] },
    })
    const dispose = await (plugin as any).setup(h.ctx)
    h.events.push({ id: "evt_2", type: "session.execution.succeeded", data: { sessionID: "ses_child" } })

    // 给事件一点时间被消费
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.created).toHaveLength(0)
    expect(h.prompts).toHaveLength(0)

    await dispose()
    h.events.close()
  })

  test("root 自己成功完成、或事件是失败态，都不复核", async () => {
    tempState()
    const h = harness({
      sessions: [{ id: "ses_root" }],
      entries: { ses_root: [{ key: "superagent.critic-enabled", value: "true" }] },
    })
    const dispose = await (plugin as any).setup(h.ctx)
    h.events.push({ id: "evt_3", type: "session.execution.succeeded", data: { sessionID: "ses_root" } })
    h.events.push({ id: "evt_4", type: "session.execution.failed", data: { sessionID: "ses_root" } })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.created).toHaveLength(0)

    await dispose()
    h.events.close()
  })

  test("critic 会话完成不再复核（防递归）", async () => {
    tempState()
    const h = harness({
      sessions: [
        { id: "ses_root" },
        { id: "ses_critic", parentID: "ses_root", title: "Critic: 复核 修复登录", metadata: { "superagent.critic": true } },
      ],
      entries: { ses_root: [{ key: "superagent.critic-enabled", value: "true" }] },
    })
    const dispose = await (plugin as any).setup(h.ctx)
    h.events.push({ id: "evt_5", type: "session.execution.succeeded", data: { sessionID: "ses_critic" } })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.created).toHaveLength(0)

    await dispose()
    h.events.close()
  })
})

describe("超时探针（真实 ctx 接线 + 注入时间）", () => {
  function probeHarness(busyAt: number, overrides: Partial<FakeSession> = {}) {
    const h = harness({
      sessions: [
        { id: "ses_root", title: "root" },
        { id: "ses_child", parentID: "ses_root", time: { created: busyAt, busy: busyAt }, ...overrides },
      ],
      entries: { ses_root: [{ key: "superagent.max-subagents", value: 5 }] },
    })
    const scanner = createCtxProbeScanner(h.ctx, { now: () => NOW, claim: () => true, log: () => {} })
    return { h, scanner }
  }

  test("阈值与 TUI 的长运行阈值同值", () => {
    expect(PROBE_AFTER_MS).toBe(LONG_RUNNING_THRESHOLD_MS)
  })

  test("busy 满 30 分钟的子会话收到 steer 探针", async () => {
    const { h, scanner } = probeHarness(NOW - 30 * 60 * 1000 - 1000)
    expect(await scanner.scan()).toBe(1)
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]!.sessionID).toBe("ses_child")
    expect(h.prompts[0]!.delivery).toBe("steer")
    expect(h.prompts[0]!.text).toBe(PROBE_TEXT)
  })

  test("不足 30 分钟不发", async () => {
    const { h, scanner } = probeHarness(NOW - 10 * 60 * 1000)
    expect(await scanner.scan()).toBe(0)
    expect(h.prompts).toHaveLength(0)
  })

  test("每会话只发一次", async () => {
    const { h, scanner } = probeHarness(NOW - 31 * 60 * 1000)
    expect(await scanner.scan()).toBe(1)
    expect(await scanner.scan()).toBe(0)
    expect(h.prompts).toHaveLength(1)
  })

  test("critic 会话与已完成会话不发", async () => {
    const critic = probeHarness(NOW - 31 * 60 * 1000, { title: "Critic: 复核 x", metadata: { "superagent.critic": true } })
    expect(await critic.scanner.scan()).toBe(0)
    const done = probeHarness(NOW - 31 * 60 * 1000, { outcome: "succeeded" })
    expect(await done.scanner.scan()).toBe(0)
  })
})

describe("critic 会话不占子代理名额", () => {
  test("listChildren 过滤掉挂在 root 下的 critic 复核会话", async () => {
    const { listChildren } = await import("./server")
    const now = Date.now()
    const ctx = {
      session: {
        list: async () => ({
          data: [
            { id: "ses_child", title: "修复登录", time: { created: now - 1000, busy: now - 500 } },
            { id: "ses_critic", title: "Critic: 复核 修复登录", time: { created: now - 1000, busy: now - 500 } },
            { id: "ses_marked", title: "普通", metadata: { "superagent.critic": true }, time: { created: now } },
          ],
        }),
      },
    }
    const children = await listChildren(ctx, "ses_root", now)
    expect(children.map((child) => child.id)).toEqual(["ses_child"])
  })
})

describe("dispose 清理探针定时器", () => {
  test("setup 返回的清理函数会 clearInterval", async () => {
    tempState()
    const h = harness({ sessions: [{ id: "ses_root" }] })
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    const cleared: any[] = []
    const handle = "probe-handle"
    globalThis.setInterval = ((fn: any) => {
      // 不真的挂定时器，避免测试期间反复扫描
      return handle as any
    }) as any
    globalThis.clearInterval = ((value: any) => {
      cleared.push(value)
    }) as any
    try {
      const dispose = await (plugin as any).setup(h.ctx)
      await dispose()
      expect(cleared).toEqual([handle])
    } finally {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
      h.events.close()
    }
  })
})