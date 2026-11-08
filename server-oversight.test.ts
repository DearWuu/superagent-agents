/**
 * 监管等级跨端：`session.execution.succeeded` 时同时读 child 与 root 的
 * `superagent.oversight-level`，L4 即使 critic 关闭也强制独立复核；
 * 协作总开关仍然优先；条目读取失败保持 critic fail-closed。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import plugin, { OVERSIGHT_LEVEL_KEY } from "./server"

type Entry = { key: string; value: unknown }

type HarnessOptions = {
  entries?: Record<string, Entry[]>
  failRootEntries?: boolean
  failChildEntries?: boolean
  criticAnswer?: string
  childReport?: string
}

function eventQueue() {
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
    push(event: any) {
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

function harness(options: HarnessOptions = {}) {
  const sessions = new Map<string, any>([
    ["ses_root", { id: "ses_root", title: "root", time: {} }],
    ["ses_child", { id: "ses_child", parentID: "ses_root", title: "修复登录", time: {} }],
  ])
  const hooks: Record<string, any> = {}
  const created: any[] = []
  const prompts: any[] = []
  const updated: any[] = []
  const removed: string[] = []
  const events = eventQueue()

  const ctx = {
    tool: {
      hook: async (name: string, handler: any) => {
        hooks[`tool:${name}`] = handler
        return { dispose() {} }
      },
    },
    event: { subscribe: () => events.iterable },
    session: {
      hook: async (name: string, handler: any) => {
        hooks[`session:${name}`] = handler
        return { dispose() {} }
      },
      async get({ sessionID }: { sessionID: string }) {
        const found = sessions.get(sessionID)
        if (!found) throw new Error(`no session ${sessionID}`)
        return { ...found }
      },
      async list() {
        return { data: [...sessions.values()] }
      },
      async create(input: any) {
        created.push(input)
        const id = "ses_critic"
        sessions.set(id, {
          id,
          parentID: input.parentID,
          title: input.title,
          metadata: input.metadata,
          time: { busy: 1, idle: 2 },
        })
        return sessions.get(id)
      },
      async update(input: any) {
        updated.push(input)
        const found = sessions.get(input.sessionID)
        if (found) found.metadata = input.metadata
      },
      async remove({ sessionID }: { sessionID: string }) {
        removed.push(sessionID)
        sessions.delete(sessionID)
      },
      async prompt(input: any) {
        prompts.push(input)
        return { id: `msg_${prompts.length}` }
      },
      async context({ sessionID }: { sessionID: string }) {
        const text =
          sessionID === "ses_critic" ? (options.criticAnswer ?? "verdict: 一致\ndifferences:\n- 无") : (options.childReport ?? "我改了 src/a.ts")
        return [{ id: "msg_1", type: "assistant", content: [{ type: "text", text }] }]
      },
      async createProbe() {},
      async switchModel() {},
      instructions: {
        entry: {
          async list({ sessionID }: { sessionID: string }) {
            if (options.failRootEntries && sessionID === "ses_root") throw new Error("root instructions down")
            if (options.failChildEntries && sessionID === "ses_child") throw new Error("child instructions down")
            return options.entries?.[sessionID] ?? []
          },
          async put() {},
          async remove() {},
        },
      },
    },
  }
  return { ctx, hooks, created, prompts, updated, removed, events, sessions }
}

const cleanups: string[] = []

function tempState() {
  const dir = mkdtempSync(path.join(tmpdir(), "superagent-oversight-"))
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

function hookLog(): any[] {
  try {
    return readFileSync(process.env.SUPERAGENT_HOOK_LOG!, "utf8")
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

async function run(options: HarnessOptions) {
  tempState()
  const h = harness(options)
  const dispose = await (plugin as any).setup(h.ctx)
  h.events.push({ id: "evt_1", type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  return { ...h, dispose }
}

describe("L4 强制 critic", () => {
  test("child L4 + root critic 关闭：仍然发起独立复核", async () => {
    const h = await run({
      entries: {
        ses_root: [{ key: "superagent.critic-enabled", value: "false" }],
        ses_child: [{ key: OVERSIGHT_LEVEL_KEY, value: 4 }],
      },
    })
    expect(await waitFor(() => h.created.length > 0)).toBe(true)
    expect(h.created[0].parentID).toBe("ses_root")
    expect(h.prompts.length).toBeGreaterThan(0)
    const level = hookLog().find((record) => record.event === "critic-level")
    expect(level).toMatchObject({ childLevel: 4, level: 4 })
    await h.dispose()
    h.events.close()
  })

  test("child L2 + root critic 关闭：不复核", async () => {
    const h = await run({
      entries: {
        ses_root: [{ key: "superagent.critic-enabled", value: "false" }],
        ses_child: [{ key: OVERSIGHT_LEVEL_KEY, value: 2 }],
      },
    })
    expect(h.created).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })

  test("child L0 仍遵循 root critic 开关：开则复核", async () => {
    const h = await run({
      entries: {
        ses_root: [{ key: "superagent.critic-enabled", value: "true" }],
        ses_child: [{ key: OVERSIGHT_LEVEL_KEY, value: 0 }],
      },
    })
    expect(await waitFor(() => h.created.length > 0)).toBe(true)
    await h.dispose()
    h.events.close()
  })

  test("root L4、child 未设置：即使 critic 关闭也复核", async () => {
    const h = await run({
      entries: {
        ses_root: [
          { key: "superagent.critic-enabled", value: "false" },
          { key: OVERSIGHT_LEVEL_KEY, value: 4 },
        ],
      },
    })
    expect(await waitFor(() => h.created.length > 0)).toBe(true)
    const level = hookLog().find((record) => record.event === "critic-level")
    expect(level).toMatchObject({ childLevel: null, rootLevel: 4, level: 4 })
    await h.dispose()
    h.events.close()
  })

  test("child 非法值回退 root 等级，不误判 L4", async () => {
    const h = await run({
      entries: {
        ses_root: [
          { key: "superagent.critic-enabled", value: "false" },
          { key: OVERSIGHT_LEVEL_KEY, value: 3 },
        ],
        ses_child: [{ key: OVERSIGHT_LEVEL_KEY, value: "L4" }],
      },
    })
    expect(h.created).toHaveLength(0)
    const level = hookLog().find((record) => record.event === "critic-level")
    expect(level).toMatchObject({ childLevel: null, rootLevel: 3, level: 3 })
    await h.dispose()
    h.events.close()
  })

  test("协作总开关关闭时 L4 也不能越过", async () => {
    const h = await run({
      entries: {
        ses_root: [{ key: "superagent.collab-enabled", value: "false" }],
        ses_child: [{ key: OVERSIGHT_LEVEL_KEY, value: 4 }],
      },
    })
    expect(h.created).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })
})

describe("条目读取失败 fail-closed", () => {
  test("root 条目读取失败：即使 child L4 也不复核，日志如实记录", async () => {
    const h = await run({
      entries: { ses_child: [{ key: OVERSIGHT_LEVEL_KEY, value: 4 }] },
      failRootEntries: true,
    })
    expect(h.created).toHaveLength(0)
    const log = hookLog()
    expect(log.some((record) => record.event === "collab-read-failed")).toBe(true)
    const level = log.find((record) => record.event === "critic-level")
    expect(level).toMatchObject({ rootReadFailed: true, childLevel: 4 })
    await h.dispose()
    h.events.close()
  })

  test("child 条目读取失败：按 root 等级处理，root critic 开则照常复核", async () => {
    const h = await run({
      entries: { ses_root: [{ key: "superagent.critic-enabled", value: "true" }] },
      failChildEntries: true,
    })
    expect(await waitFor(() => h.created.length > 0)).toBe(true)
    const log = hookLog()
    expect(log.some((record) => record.event === "oversight-child-read-failed")).toBe(true)
    expect(log.find((record) => record.event === "critic-level")).toMatchObject({ childLevel: null, childReadFailed: true })
    await h.dispose()
    h.events.close()
  })
})