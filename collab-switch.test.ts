/** @jsxImportSource @opentui/solid */
/**
 * 协作模式总开关按 family root 会话隔离：
 *  - 开关值是该 root 的 `superagent.collab-enabled` 指令条目；
 *  - root A 停用不影响 root B；同 root 子代理继承；
 *  - 缺省、值异常、读取失败都按启用处理（fail-open）。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import plugin, {
  COLLAB_ENABLED_KEY,
  PROBE_AFTER_MS,
  collabEnabledFromEntries,
  createCtxCompactionScanner,
  createProbeScanner,
  readCollabState,
} from "./server"

mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (value: unknown) => value } }))
const tui = await import("./index")

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "superagent-collab-"))
  process.env.SUPERAGENT_HOOK_LOG = path.join(root, "hook.log")
  process.env.SUPERAGENT_STATE_DIR = path.join(root, "state-root")
})

afterEach(() => {
  delete process.env.SUPERAGENT_HOOK_LOG
  delete process.env.SUPERAGENT_STATE_DIR
  delete process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS
  rmSync(root, { recursive: true, force: true })
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

type SessionSpec = { parentID?: string; title?: string }
type Entries = Record<string, Record<string, string | number | boolean>>

/** 捕获 setup 注册的钩子，并按 sessionID 提供 root 链与指令条目。 */
function fakeCtx(options: {
  sessions?: Record<string, SessionSpec>
  entries?: Entries
  throwInstructions?: boolean
  messages?: Record<string, any[]>
} = {}) {
  const hooks: Record<string, any> = {}
  const calls = {
    instructions: 0,
    instructionSessions: [] as string[],
    switchModel: 0,
    prompt: 0,
    create: 0,
    list: 0,
    remove: 0,
    puts: [] as Array<{ sessionID: string; key: string; value: unknown }>,
  }
  const sessions =
    options.sessions ??
    ({
      ses_a_root: {},
      ses_a_child: { parentID: "ses_a_root" },
      ses_b_root: {},
      ses_b_child: { parentID: "ses_b_root" },
    } as Record<string, SessionSpec>)
  const entries: Entries = structuredClone(options.entries ?? {})
  let instructionThrows = options.throwInstructions ? 1 : 0
  const buffered: any[] = []
  let notify: (() => void) | undefined
  const events = {
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (buffered.length > 0) {
            yield buffered.shift()
            continue
          }
          await new Promise<void>((resolve) => {
            notify = resolve
          })
        }
      },
    },
    push(event: any) {
      buffered.push(event)
      notify?.()
      notify = undefined
    },
    close() {
      notify?.()
      notify = undefined
    },
  }
  const ctx = {
    tool: {
      hook: async (name: string, handler: any) => {
        hooks[`tool:${name}`] = handler
        return { dispose() {} }
      },
    },
    session: {
      hook: async (name: string, handler: any) => {
        hooks[`session:${name}`] = handler
        return { dispose() {} }
      },
      async get({ sessionID }: { sessionID: string }) {
        if (sessionID === "ses_critic") {
          return { id: sessionID, parentID: "ses_b_root", time: { busy: 1, idle: 2 }, outcome: "succeeded" }
        }
        const found = sessions[sessionID]
        if (!found) throw new Error(`no session ${sessionID}`)
        return { id: sessionID, parentID: found.parentID, title: found.title, time: {} }
      },
      async list() {
        calls.list++
        return { data: [] }
      },
      async context({ sessionID }: { sessionID: string }) {
        return options.messages?.[sessionID] ?? []
      },
      async create(input: any) {
        calls.create++
        return { id: "ses_critic", parentID: input.parentID, time: { busy: 1, idle: 2 } }
      },
      async update() {},
      async remove() {
        calls.remove++
      },
      async prompt() {
        calls.prompt++
      },
      async switchModel() {
        calls.switchModel++
      },
      instructions: {
        entry: {
          async list({ sessionID }: { sessionID: string }) {
            calls.instructions++
            calls.instructionSessions.push(sessionID)
            if (instructionThrows > 0) {
              instructionThrows -= 1
              throw new Error("instructions down")
            }
            return Object.entries(entries[sessionID] ?? {}).map(([key, value]) => ({ key, value }))
          },
          async put(input: { sessionID: string; key: string; value: unknown }) {
            calls.puts.push(input)
            entries[input.sessionID] = { ...(entries[input.sessionID] ?? {}), [input.key]: input.value as any }
          },
          async remove({ sessionID, key }: { sessionID: string; key: string }) {
            if (entries[sessionID]) delete entries[sessionID][key]
          },
        },
      },
    },
    event: { subscribe: () => events.iterable },
  }
  return { ctx, hooks, calls, events, entries }
}

const quotaError = { message: "429 rate limit exceeded" }

async function waitFor(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return check()
}

describe("开关解析", () => {
  test("缺省启用", () => {
    expect(readCollabState([])).toEqual({ enabled: true, reason: "default" })
    expect(collabEnabledFromEntries(undefined)).toBe(true)
  })

  test("false 停用、true 启用", () => {
    expect(readCollabState([{ key: COLLAB_ENABLED_KEY, value: "false" }])).toEqual({
      enabled: false,
      reason: "configured",
    })
    expect(readCollabState([{ key: COLLAB_ENABLED_KEY, value: "true" }]).enabled).toBe(true)
  })

  test("异常值按启用处理", () => {
    expect(readCollabState([{ key: COLLAB_ENABLED_KEY, value: "no" }])).toEqual({
      enabled: true,
      reason: "corrupt",
    })
    expect(readCollabState([{ key: COLLAB_ENABLED_KEY, value: null }]).enabled).toBe(true)
  })

  test("TUI 与 server 同口径", () => {
    expect(tui.collabEnabledFromInstructions({})).toBe(true)
    expect(tui.collabEnabledFromInstructions({ [COLLAB_ENABLED_KEY]: "false" })).toBe(false)
    expect(tui.collabEnabledFromInstructions({ [COLLAB_ENABLED_KEY]: "true" })).toBe(true)
    expect(tui.collabEnabledFromInstructions({ [COLLAB_ENABLED_KEY]: "broken" })).toBe(true)
  })
})

describe("root A 停用时服务端短路", () => {
  const entries = { ses_a_root: { [COLLAB_ENABLED_KEY]: "false" }, ses_b_root: { "superagent.max-subagents": 5 } }

  test("硬拦截不执行：不查子会话、不占槽", async () => {
    const { ctx, hooks, calls } = fakeCtx({ entries })
    const dispose = await (plugin as any).setup(ctx)

    await expect(
      hooks["tool:execute.before"]({ tool: "subagent", sessionID: "ses_a_root", id: "call_1", agent: "build" }),
    ).resolves.toBeUndefined()
    expect(calls.list).toBe(0)
    expect(calls.instructionSessions).toEqual(["ses_a_root"])

    await dispose()
  })

  test("steer 分支也不登记：不写 subagent-steer 日志", async () => {
    const { ctx, hooks, calls } = fakeCtx({ entries })
    const dispose = await (plugin as any).setup(ctx)

    await hooks["tool:execute.before"]({
      tool: "subagent",
      sessionID: "ses_a_root",
      id: "call_steer",
      agent: "build",
      input: { sessionID: "ses_a_child" },
    })
    expect(calls.list).toBe(0)
    expect(hookLog().some((record) => record.event === "subagent-steer")).toBe(false)

    await dispose()
  })

  test("同 root 子会话也停用", async () => {
    const { ctx, hooks, calls } = fakeCtx({ entries })
    const dispose = await (plugin as any).setup(ctx)

    await hooks["tool:execute.before"]({
      tool: "subagent",
      sessionID: "ses_a_child",
      id: "call_child",
      agent: "build",
    })
    expect(calls.list).toBe(0)
    expect(calls.instructionSessions).toEqual(["ses_a_root"])

    await dispose()
  })

  test("root B 缺省仍执行硬拦截流程", async () => {
    const { ctx, hooks, calls } = fakeCtx({ entries })
    const dispose = await (plugin as any).setup(ctx)

    await hooks["tool:execute.before"]({ tool: "subagent", sessionID: "ses_b_root", id: "call_b", agent: "build" })
    expect(calls.list).toBeGreaterThan(0)

    await dispose()
  })

  test("限额切换不执行：A 停用协作，多次失败并等到点也不切模型", async () => {
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const { ctx, hooks, calls } = fakeCtx({ entries })
    const dispose = await (plugin as any).setup(ctx)

    for (let i = 0; i < 3; i += 1) {
      await hooks["session:retry"]({
        sessionID: "ses_a_root",
        error: quotaError,
        model: { providerID: "acme", id: "big" },
      })
    }
    expect(calls.switchModel).toBe(0)
    expect(calls.instructionSessions).toEqual(["ses_a_root", "ses_a_root", "ses_a_root"])
    // 过了计时窗口也不切：停用协作的 root 根本不进入计时。
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(calls.switchModel).toBe(0)

    await dispose()
  })

  test("root B 的同一 retry 到点后切备用模型（对照）", async () => {
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const { ctx, hooks, calls } = fakeCtx({
      entries: {
        ses_b_root: { "superagent.fallback-model": "acme/backup" },
      },
    })
    const dispose = await (plugin as any).setup(ctx)

    await hooks["session:retry"]({
      sessionID: "ses_b_root",
      error: quotaError,
      model: { providerID: "acme", id: "big" },
    })
    expect(calls.switchModel).toBe(0)
    const deadline = Date.now() + 3000
    while (calls.switchModel === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(calls.switchModel).toBe(1)

    await dispose()
  })

  test("critic 不触发：A 的子会话成功完成也不建复核会话", async () => {
    const { ctx, events, calls } = fakeCtx({ entries })
    const dispose = await (plugin as any).setup(ctx)

    events.push({ id: "evt_1", type: "session.execution.succeeded", data: { sessionID: "ses_a_child" } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(calls.create).toBe(0)
    expect(calls.prompt).toBe(0)

    events.close()
    await dispose()
  })

  test("critic 在 root B 仍然触发（对照）", async () => {
    const { ctx, events, calls } = fakeCtx({
      entries: { ses_b_root: { "superagent.critic-enabled": "true" } },
      messages: {
        ses_b_child: [{ type: "assistant", text: "完成：改了 a.ts" }],
        ses_critic: [{ type: "assistant", text: "一致" }],
      },
    })
    const dispose = await (plugin as any).setup(ctx)

    events.push({ id: "evt_2", type: "session.execution.succeeded", data: { sessionID: "ses_b_child" } })
    expect(await waitFor(() => calls.create > 0)).toBe(true)
    expect(calls.prompt).toBeGreaterThan(0)

    events.close()
    await dispose()
  })

  test("读取失败 fail-open：仍走后续拦截流程并留日志", async () => {
    const { ctx, hooks, calls } = fakeCtx({ throwInstructions: true })
    const dispose = await (plugin as any).setup(ctx)

    await hooks["tool:execute.before"]({ tool: "subagent", sessionID: "ses_a_root", id: "call_x", agent: "build" })
    expect(calls.list).toBeGreaterThan(0)
    expect(hookLog().some((record) => record.event === "collab-read-failed")).toBe(true)

    await dispose()
  })
})

describe("扫描器逐 root 判断", () => {
  test("探针：A 停用不发，B 缺省照常发；整轮不会因 A 被跳过", async () => {
    let listed = 0
    const sent: string[] = []
    const now = Date.now()
    const scanner = createProbeScanner({
      listSessions: async () => {
        listed++
        return [
          { id: "ses_a_child", busy: now - PROBE_AFTER_MS - 1 },
          { id: "ses_b_child", busy: now - PROBE_AFTER_MS - 1 },
        ]
      },
      resolveRoot: async (sessionID) => (sessionID.startsWith("ses_a") ? "ses_a_root" : "ses_b_root"),
      rootIsEnabled: async (rootID) => rootID !== "ses_a_root",
      rootIsConfigured: async () => true,
      sendProbe: async (sessionID) => {
        sent.push(sessionID)
      },
      claim: () => true,
      log: () => {},
      now: () => now,
    })

    expect(await scanner.scan()).toBe(1)
    expect(listed).toBe(1)
    expect(sent).toEqual(["ses_b_child"])
  })

  test("上下文自动压缩：A 停用不压，B 照常压缩自己的子代理", async () => {
    const compacted: string[] = []
    const now = Date.now()
    const scanner = createCtxCompactionScanner({
      listSessions: async () => [
        { id: "ses_a_child", title: "A", busy: now - 1 },
        { id: "ses_b_child", title: "B", busy: now - 1 },
      ],
      resolveRoot: async (sessionID) => (sessionID.startsWith("ses_a") ? "ses_a_root" : "ses_b_root"),
      rootIsEnabled: async (rootID) => rootID !== "ses_a_root",
      rootIsConfigured: async () => true,
      readTokens: async () => 350_000,
      compactSession: async (childSessionID) => {
        compacted.push(childSessionID)
      },
      claim: () => true,
      log: () => {},
      now: () => now,
    })

    expect(await scanner.scan()).toBe(1)
    expect(compacted).toEqual(["ses_b_child"])
  })

  test("开关读取异常按启用处理并留日志", async () => {
    const logs: any[] = []
    const sent: string[] = []
    const now = Date.now()
    const scanner = createProbeScanner({
      listSessions: async () => [{ id: "ses_child", busy: now - PROBE_AFTER_MS - 1 }],
      resolveRoot: async () => "ses_root",
      rootIsEnabled: async () => {
        throw new Error("switch down")
      },
      rootIsConfigured: async () => true,
      sendProbe: async (sessionID) => {
        sent.push(sessionID)
      },
      claim: () => true,
      log: (record) => logs.push(record),
      now: () => now,
    })

    expect(await scanner.scan()).toBe(1)
    expect(sent).toEqual(["ses_child"])
    expect(logs.some((record) => record.event === "probe-collab-failed")).toBe(true)
  })
})