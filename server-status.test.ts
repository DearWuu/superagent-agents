/**
 * 状态回传接线：用假 ctx 驱动真实 `setup()`，覆盖派发回执、fail-open 告警、
 * interrupt 结果回传、后台任务通知与判重、完成补发，以及周期对账的兜底提醒。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

import plugin from "./server"

const cleanups: string[] = []

function tempState() {
  const dir = mkdtempSync(path.join(tmpdir(), "superagent-status-"))
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
  delete process.env.SUPERAGENT_STATUS_RECONCILE_MS
})

type FakeSession = {
  id: string
  parentID?: string
  title?: string
  agent?: string
  model?: any
  metadata?: Record<string, unknown>
  outcome?: string | null
  time?: { created?: number; busy?: number; idle?: number; archived?: number }
}

type Entry = { key: string; value: unknown }

type HarnessOptions = {
  sessions: FakeSession[]
  entries?: Record<string, Entry[]>
  /** 原生 subagent 工具的返回值；函数形式按输入生成。 */
  result?: any | ((input: any) => any)
  /** 各会话的消息列表（可运行时改）。 */
  messages?: Record<string, any[]>
  interruptError?: Error
  /** 指令条目读取失败：驱动 lookup-failed 的 fail-open。 */
  failEntryList?: boolean
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

function harness(options: HarnessOptions) {
  const sessions = new Map<string, FakeSession>()
  for (const session of options.sessions) sessions.set(session.id, structuredClone(session))
  const messages = new Map<string, any[]>()
  for (const [key, value] of Object.entries(options.messages ?? {})) messages.set(key, structuredClone(value))
  const hooks: Record<string, any> = {}
  const synthetics: any[] = []
  const updates: Array<{ sessionID: string; metadata?: Record<string, unknown> }> = []
  const calls: any[] = []
  const interrupts: string[] = []
  const events = eventQueue()
  const transformCallbacks: Array<(editor: any) => void> = []

  const tool: any = {
    id: "subagent",
    name: "subagent",
    description: "native subagent",
    input: Schema.Struct({
      agent: Schema.String,
      prompt: Schema.String,
      model: Schema.optional(Schema.String),
      sessionID: Schema.optional(Schema.String),
      background: Schema.optional(Schema.Boolean),
      description: Schema.optional(Schema.String),
    }),
    execute: async (input: any) => {
      calls.push(input)
      const fallback = { output: "done", metadata: { sessionID: "ses_child", status: "completed" } }
      const value = typeof options.result === "function" ? options.result(input) : options.result
      return structuredClone(value ?? fallback)
    },
  }

  const editor = () => ({
    get: (id: string) => (id === "subagent" ? tool : undefined),
    update: (id: string, update: (value: any) => void) => {
      if (id !== "subagent") return
      const value = { ...tool }
      update(value)
      Object.assign(tool, value)
    },
    add() {},
    remove() {},
    namespace() {},
    list: () => [tool],
  })

  const ctx = {
    tool: {
      hook: async (name: string, handler: any) => {
        hooks[`tool:${name}`] = handler
        return { dispose() {} }
      },
      transform: async (callback: any) => {
        transformCallbacks.push(callback)
        callback(editor())
        return { dispose() {} }
      },
    },
    skill: {
      transform: async (callback: any) => {
        callback({ get: () => undefined, add() {} })
        return { dispose() {} }
      },
    },
    event: { subscribe: () => events.iterable },
    agent: {
      get: async ({ agentID }: { agentID: string }) => ({ data: { id: agentID, name: agentID } }),
    },
    model: { list: async () => ({ data: [] }) },
    session: {
      hook: async (name: string, handler: any) => {
        hooks[`session:${name}`] = handler
        return { dispose() {} }
      },
      async get({ sessionID }: { sessionID: string }) {
        const found = sessions.get(sessionID)
        if (!found) throw new Error(`no session ${sessionID}`)
        return structuredClone(found)
      },
      async list({ parentID }: { parentID?: string } = {}) {
        const data = [...sessions.values()]
          .filter((session) => (parentID === undefined ? true : session.parentID === parentID))
          .filter((session) => session.time?.archived === undefined)
          .map((session) => structuredClone(session))
        return { data }
      },
      async update(input: { sessionID: string; metadata?: Record<string, unknown> }) {
        updates.push(structuredClone(input))
        const found = sessions.get(input.sessionID)
        if (found && input.metadata !== undefined) found.metadata = structuredClone(input.metadata)
      },
      async remove({ sessionID }: { sessionID: string }) {
        sessions.delete(sessionID)
      },
      async prompt() {
        return { id: "msg_prompt" }
      },
      async context({ sessionID }: { sessionID: string }) {
        return { data: structuredClone(messages.get(sessionID) ?? []) }
      },
      async synthetic(input: any) {
        synthetics.push(structuredClone(input))
        return { id: `msg_syn_${synthetics.length}` }
      },
      async interrupt({ sessionID }: { sessionID: string }) {
        interrupts.push(sessionID)
        if (options.interruptError) throw options.interruptError
        const found = sessions.get(sessionID)
        if (found) found.time = { ...found.time, busy: found.time?.busy ?? 1, idle: (found.time?.busy ?? 1) + 1 }
        return {}
      },
      async create() {
        throw new Error("not used")
      },
      async switchModel() {},
      instructions: {
        entry: {
          async list({ sessionID }: { sessionID: string }) {
            if (options.failEntryList) throw new Error("instructions down")
            return structuredClone(options.entries?.[sessionID] ?? [])
          },
          async put() {},
          async remove() {},
        },
      },
    },
  }

  return {
    ctx,
    tool,
    hooks,
    synthetics,
    updates,
    calls,
    interrupts,
    events,
    sessions,
    messages,
    setMessages(sessionID: string, value: any[]) {
      messages.set(sessionID, structuredClone(value))
    },
  }
}

async function setup(options: HarnessOptions) {
  const h = harness(options)
  const dispose = await (plugin as any).setup(h.ctx)
  return { ...h, dispose }
}

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

async function waitFor(check: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return check()
}

const rootSession: FakeSession = { id: "ses_root", title: "root", agent: "superagent" }

function childSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    id: "ses_child",
    parentID: "ses_root",
    agent: "worker",
    outcome: "succeeded",
    time: { created: 1, busy: 2, idle: 3 },
    ...overrides,
  }
}

/** 派发一次子代理：先跑 before 钩子，再跑被包装的原生工具，最后跑 after 钩子。 */
async function dispatch(
  h: Awaited<ReturnType<typeof setup>>,
  input: Record<string, unknown> = {},
  callID = "call-1",
) {
  await h.hooks["tool:execute.before"]({
    tool: "subagent",
    sessionID: "ses_root",
    id: callID,
    agent: "superagent",
    input: { agent: "worker", description: "任务", prompt: "go", ...input },
  })
  const result = await h.tool.execute(
    { agent: "worker", description: "任务", prompt: "go", ...input },
    { id: callID, sessionID: "ses_root", signal: new AbortController().signal },
  )
  await h.hooks["tool:execute.after"]({ tool: "subagent", id: callID })
  return result
}

/** 后台 shell 消息：后台启动且仍在跑。 */
function backgroundShell(command = "npm run dev") {
  return {
    id: "msg_shell",
    type: "shell",
    shellID: "sh_1",
    command,
    status: "running",
    metadata: { background: true },
    time: { created: 10 },
  }
}

describe("派发回执", () => {
  test("协作开启时回执挂到工具结果上", async () => {
    tempState()
    const h = await setup({ sessions: [rootSession, childSession()] })
    const result = await dispatch(h)
    expect(String(result.output)).toContain("[superagent] dispatch=ok")
    expect(String(result.output)).toContain("child=ses_child")
    expect(String(result.output)).toContain("state=completed")
    expect(String(result.output)).toContain("interrupt=not-needed")
    const row = hookLog().find((record) => record.event === "status-dispatch")
    expect(row.callID).toBe("call-1")
    expect(row.childSessionID).toBe("ses_child")
    await h.dispose()
    h.events.close()
  })

  test("本次自动淘汰写进回执", async () => {
    tempState()
    const sessions = [rootSession]
    for (let index = 1; index <= 5; index += 1) {
      sessions.push(
        childSession({
          id: `ses_old${index}`,
          time: { created: index, busy: index + 1, idle: index + 2 },
        }),
      )
    }
    const h = await setup({ sessions })
    const result = await dispatch(h)
    expect(String(result.output)).toContain("evicted=ses_old1")
    await h.dispose()
    h.events.close()
  })

  test("协作关闭时不登记台账，也不挂回执", async () => {
    tempState()
    const h = await setup({
      sessions: [rootSession, childSession()],
      entries: { ses_root: [{ key: "superagent.collab-enabled", value: "false" }] },
    })
    const result = await dispatch(h)
    expect(String(result.output)).not.toContain("[superagent]")
    expect(hookLog().some((record) => record.event === "status-dispatch")).toBe(false)
    await h.dispose()
    h.events.close()
  })

  test("fail-open 判定失败时回执带上告警", async () => {
    tempState()
    const h = await setup({ sessions: [rootSession, childSession()], failEntryList: true })
    const result = await dispatch(h)
    expect(String(result.output)).toContain("warning=")
    expect(String(result.output)).toContain("已放行")
    expect(hookLog().some((record) => record.event === "lookup-failed")).toBe(true)
    await h.dispose()
    h.events.close()
  })
})

describe("interrupt 结果回传", () => {
  test("默认续跑不抢占：回执写 interrupt=off，且不调用 interrupt", async () => {
    tempState()
    const h = await setup({
      sessions: [rootSession, childSession({ outcome: null, time: { created: 1, busy: 2 } })],
    })
    const result = await dispatch(h, { sessionID: "ses_child" })
    expect(String(result.output)).toContain("interrupt=off")
    expect(String(result.output)).toContain("mode=steer")
    expect(h.interrupts).toEqual([])
    await h.dispose()
    h.events.close()
  })

  test("显式 interrupt:true：运行中的子会话被中断，回执写 interrupt=interrupted", async () => {
    tempState()
    const h = await setup({
      sessions: [rootSession, childSession({ outcome: null, time: { created: 1, busy: 2 } })],
    })
    const result = await dispatch(h, { sessionID: "ses_child", interrupt: true })
    expect(String(result.output)).toContain("interrupt=interrupted")
    expect(String(result.output)).toContain("mode=steer")
    expect(h.interrupts).toEqual(["ses_child"])
    await h.dispose()
    h.events.close()
  })

  test("显式 interrupt:false：回执写 interrupt=off 且不调用 interrupt", async () => {
    tempState()
    const h = await setup({
      sessions: [rootSession, childSession({ outcome: null, time: { created: 1, busy: 2 } })],
    })
    const result = await dispatch(h, { sessionID: "ses_child", interrupt: false })
    expect(String(result.output)).toContain("interrupt=off")
    expect(h.interrupts).toEqual([])
    await h.dispose()
    h.events.close()
  })

  test("中断失败：明确抛错并留下 interrupt=failed 的记录", async () => {
    tempState()
    const h = await setup({
      sessions: [rootSession, childSession({ outcome: null, time: { created: 1, busy: 2 } })],
      interruptError: new Error("host refused"),
    })
    let failed: any
    try {
      await dispatch(h, { sessionID: "ses_child", interrupt: true })
    } catch (cause) {
      failed = cause
    }
    expect(String(failed?.message)).toContain("中断子会话 ses_child 失败")
    expect(String(failed?.message)).toContain("host refused")
    const row = hookLog().find((record) => record.event === "status-dispatch" && record.interrupt === "failed")
    expect(row).toBeDefined()
    await h.dispose()
    h.events.close()
  })
})

describe("后台任务状态回传", () => {
  test("前台派发留下后台任务：通知 parent 并在子会话写运行标记", async () => {
    tempState()
    const h = await setup({
      sessions: [rootSession, childSession()],
      messages: { ses_child: [backgroundShell()] },
    })
    await dispatch(h)
    expect(await waitFor(() => h.synthetics.length === 1)).toBe(true)
    const notice = h.synthetics[0]
    expect(notice.sessionID).toBe("ses_root")
    expect(notice.metadata).toEqual({
      source: "superagent-agents",
      childID: "ses_child",
      state: "idle-background",
    })
    expect(String(notice.text)).toContain("仍有 1 个后台任务在运行")
    expect(String(notice.text)).toContain("- shell: npm run dev")
    const marker = h.updates.find((update) => update.sessionID === "ses_child")
    expect(marker?.metadata?.["superagent.runtime"]).toMatchObject({ state: "idle-background" })
    await h.dispose()
    h.events.close()
  })

  test("前台派发没有后台任务：不发任何通知", async () => {
    tempState()
    const h = await setup({ sessions: [rootSession, childSession()] })
    await dispatch(h)
    await waitFor(() => h.synthetics.length > 0, 300)
    expect(h.synthetics).toEqual([])
    await h.dispose()
    h.events.close()
  })

  test("后台派发结束且没有原生通知：补发完成通知", async () => {
    tempState()
    const h = await setup({
      sessions: [rootSession, childSession({ outcome: null, time: { created: 1, busy: 2 } })],
      result: { output: "done", metadata: { sessionID: "ses_child", status: "running" } },
    })
    await dispatch(h, { background: true })
    // 子会话结束：会话不再运行。
    await waitFor(() => h.hooks["tool:execute.before"] !== undefined)
    const child = h.sessions.get("ses_child")!
    child.outcome = "succeeded"
    child.time = { created: 1, busy: 2, idle: 3 }
    h.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
    expect(await waitFor(() => h.synthetics.length === 1, 6000)).toBe(true)
    const notice = h.synthetics[0]
    expect(notice.metadata).toEqual({ source: "superagent-agents", childID: "ses_child", state: "completed" })
    expect(String(notice.text)).toContain('<subagent sessionID="ses_child" state="completed"')
    await h.dispose()
    h.events.close()
  })

  test("原生已经通知过：不重复发完成通知", async () => {
    tempState()
    const h = await setup({
      sessions: [rootSession, childSession({ outcome: null, time: { created: 1, busy: 2 } })],
      result: { output: "done", metadata: { sessionID: "ses_child", status: "running" } },
      messages: {
        ses_root: [
          {
            id: "msg_native",
            type: "synthetic",
            payload: {
              text: '<subagent sessionID="ses_child" state="completed">done</subagent>',
              metadata: { source: "subagent", childID: "ses_child", state: "completed" },
            },
          },
        ],
      },
    })
    await dispatch(h, { background: true })
    const child = h.sessions.get("ses_child")!
    child.outcome = "succeeded"
    child.time = { created: 1, busy: 2, idle: 3 }
    h.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
    await waitFor(() => h.synthetics.length > 0, 3000)
    expect(h.synthetics).toEqual([])
    await h.dispose()
    h.events.close()
  })

  test("后台 shell 结束后不再补第二条：终态通知已在工具结果里，只清运行标记", async () => {
    tempState()
    const h = await setup({
      sessions: [rootSession, childSession()],
      messages: {
        ses_child: [backgroundShell()],
        // 前台派发的工具结果里已经有终态通知：不再补收尾通知。
        ses_root: [
          {
            id: "msg_tool",
            type: "assistant",
            parts: [
              {
                type: "tool",
                state: {
                  status: "completed",
                  content: [
                    { type: "text", text: '<subagent sessionID="ses_child" state="completed">done</subagent>' },
                  ],
                },
              },
            ],
          },
        ],
      },
    })
    await dispatch(h)
    expect(await waitFor(() => h.synthetics.length === 1)).toBe(true)
    // 后台 shell 结束：子会话里不再有运行中的后台任务。
    h.setMessages("ses_child", [{ ...backgroundShell(), status: "exited" }])
    h.events.push({ type: "session.shell.ended", data: { sessionID: "ses_child" } })
    await waitFor(() => h.updates.some((update) => update.sessionID === "ses_child" && update.metadata?.["superagent.runtime"] === undefined), 4000)
    // 只清运行标记，不补第二条通知。
    expect(h.synthetics).toHaveLength(1)
    const cleared = h.updates.filter((update) => update.sessionID === "ses_child").pop()
    expect(cleared?.metadata?.["superagent.runtime"]).toBeUndefined()
    await h.dispose()
    h.events.close()
  })

  test("parent 没有终态通知时仍补一条收尾通知并清掉运行标记", async () => {
    tempState()
    const h = await setup({
      sessions: [rootSession, childSession()],
      messages: { ses_child: [backgroundShell()] },
    })
    await dispatch(h)
    expect(await waitFor(() => h.synthetics.length === 1)).toBe(true)
    // 后台 shell 结束：子会话里不再有运行中的后台任务。
    h.setMessages("ses_child", [{ ...backgroundShell(), status: "exited" }])
    h.events.push({ type: "session.shell.ended", data: { sessionID: "ses_child" } })
    expect(await waitFor(() => h.synthetics.length === 2, 4000)).toBe(true)
    const done = h.synthetics[1]
    expect(done.metadata).toEqual({ source: "superagent-agents", childID: "ses_child", state: "completed" })
    expect(String(done.text)).toContain("后台任务已全部结束")
    const cleared = h.updates.filter((update) => update.sessionID === "ses_child").pop()
    expect(cleared?.metadata?.["superagent.runtime"]).toBeUndefined()
    await h.dispose()
    h.events.close()
  })

  test("同一代后台任务只提醒一次：任务集合变了只更新运行标记", async () => {
    tempState()
    const h = await setup({
      sessions: [rootSession, childSession()],
      messages: { ses_child: [backgroundShell("npm run dev")] },
    })
    await dispatch(h)
    expect(await waitFor(() => h.synthetics.length === 1)).toBe(true)
    // 又起了一个后台任务：只更新运行标记，不再发第二条 idle-background。
    h.setMessages("ses_child", [backgroundShell("npm run build"), { ...backgroundShell("npm run dev"), shellID: "sh_0", id: "msg_shell0" }])
    h.events.push({ type: "session.shell.started", data: { sessionID: "ses_child" } })
    await waitFor(() => h.updates.length >= 3, 4000)
    expect(h.synthetics).toHaveLength(1)
    expect(h.synthetics[0].metadata?.state).toBe("idle-background")
    // 运行标记更新到最后一次的任务集合。
    const marked = h.updates.filter((update) => update.metadata?.["superagent.runtime"] !== undefined).pop()
    const runtime = marked?.metadata?.["superagent.runtime"] as any
    expect(runtime).toMatchObject({ state: "idle-background" })
    expect(runtime.background).toHaveLength(2)
    await h.dispose()
    h.events.close()
  })
})

describe("周期对账兜底", () => {
  test("开关关闭：不登记 watch，也不补发提醒", async () => {
    tempState()
    process.env.SUPERAGENT_STATUS_RECONCILE_MS = "80"
    const h = await setup({
      sessions: [rootSession, childSession({ outcome: null, time: { created: 1, busy: 2 } })],
      entries: { ses_root: [{ key: "superagent.status-watch", value: "false" }] },
      result: { output: "done", metadata: { sessionID: "ses_child", status: "running" } },
    })
    await dispatch(h, { background: true })
    const child = h.sessions.get("ses_child")!
    child.outcome = "succeeded"
    child.time = { created: 1, busy: 2, idle: 3 }
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(h.synthetics).toEqual([])
    expect(hookLog().some((record) => record.event === "status-watch-disabled")).toBe(true)
    await h.dispose()
    h.events.close()
  })

  test("子代理停了但后台任务还在跑：补后台通知，不误发完成提醒", async () => {
    tempState()
    process.env.SUPERAGENT_STATUS_RECONCILE_MS = "80"
    const h = await setup({
      sessions: [rootSession, childSession({ outcome: null, time: { created: 1, busy: 2 } })],
      result: { output: "done", metadata: { sessionID: "ses_child", status: "running" } },
      messages: { ses_child: [backgroundShell()] },
    })
    await dispatch(h, { background: true })
    const child = h.sessions.get("ses_child")!
    child.outcome = "succeeded"
    child.time = { created: 1, busy: 2, idle: 3 }
    expect(await waitFor(() => h.synthetics.length === 1, 4000)).toBe(true)
    expect(h.synthetics[0].metadata).toEqual({
      source: "superagent-agents",
      childID: "ses_child",
      state: "idle-background",
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(h.synthetics.some((item: any) => item.metadata?.state === "watch-reminder")).toBe(false)
    await h.dispose()
    h.events.close()
  })

  test("子代理停了又没人通知：补发一次提醒，重复 tick 不再补发", async () => {
    tempState()
    process.env.SUPERAGENT_STATUS_RECONCILE_MS = "80"
    const h = await setup({
      sessions: [rootSession, childSession({ outcome: null, time: { created: 1, busy: 2 } })],
      result: { output: "done", metadata: { sessionID: "ses_child", status: "running" } },
    })
    await dispatch(h, { background: true })
    await new Promise((resolve) => setTimeout(resolve, 120))
    const child = h.sessions.get("ses_child")!
    child.outcome = "succeeded"
    child.time = { created: 1, busy: 2, idle: 3 }
    expect(await waitFor(() => h.synthetics.length === 1, 4000)).toBe(true)
    const reminder = h.synthetics[0]
    expect(String(reminder.text)).toBe(
      "[superagent] 监测到子代理 ses_child 已停止（completed），此前没有收到完成确认；如已知晓可忽略。",
    )
    expect(reminder.metadata).toEqual({
      source: "superagent-agents",
      childID: "ses_child",
      state: "watch-reminder",
    })
    expect(hookLog().some((record) => record.event === "status-reminder")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(h.synthetics).toHaveLength(1)
    await h.dispose()
    h.events.close()
  })

  test("对账提醒等两拍：首个 tick 只 arm，下一拍才提醒", async () => {
    tempState()
    process.env.SUPERAGENT_STATUS_RECONCILE_MS = "60"
    const h = await setup({
      sessions: [rootSession, childSession({ outcome: null, time: { created: 1, busy: 2 } })],
      result: { output: "done", metadata: { sessionID: "ses_child", status: "running" } },
    })
    await dispatch(h, { background: true })
    await new Promise((resolve) => setTimeout(resolve, 120))
    const child = h.sessions.get("ses_child")!
    child.outcome = "succeeded"
    child.time = { created: 1, busy: 2, idle: 3 }
    // 第一个 tick：只 arm，不提醒。
    expect(await waitFor(() => hookLog().some((record) => record.event === "status-reminder-armed"), 4000)).toBe(true)
    expect(h.synthetics).toEqual([])
    // 第二个 tick 才提醒。
    expect(await waitFor(() => h.synthetics.length === 1, 4000)).toBe(true)
    const log = hookLog()
    const armed = log.find((record) => record.event === "status-reminder-armed")!
    const reminder = log.find((record) => record.event === "status-reminder")!
    expect(Date.parse(reminder.at) - Date.parse(armed.at)).toBeGreaterThanOrEqual(50)
    // 重复 tick 不重复提醒。
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(h.synthetics).toHaveLength(1)
    await h.dispose()
    h.events.close()
  })

  test("补发提醒后 parent 有新消息：不再补发", async () => {
    tempState()
    process.env.SUPERAGENT_STATUS_RECONCILE_MS = "80"
    const h = await setup({
      sessions: [
        rootSession,
        childSession({ id: "ses_c1", outcome: null, time: { created: 1, busy: 2 } }),
        childSession({ id: "ses_c2", outcome: null, time: { created: 1, busy: 2 } }),
      ],
      result: (input: any) => ({
        output: "done",
        metadata: { sessionID: `ses_c${input.description}`, status: "running" },
      }),
    })
    await dispatch(h, { background: true, description: "1" }, "call-1")
    await dispatch(h, { background: true, description: "2" }, "call-2")
    const first = h.sessions.get("ses_c1")!
    first.outcome = "succeeded"
    first.time = { created: 1, busy: 2, idle: 3 }
    expect(await waitFor(() => h.synthetics.length === 1, 4000)).toBe(true)
    // parent 收到提醒后动了起来：不再打扰。
    h.setMessages("ses_root", [
      { id: "msg_p", type: "assistant", content: [{ type: "text", text: "在做什么" }], time: { created: 5_000 } },
    ])
    const second = h.sessions.get("ses_c2")!
    second.outcome = "succeeded"
    second.time = { created: 1, busy: 2, idle: 3 }
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(h.synthetics).toHaveLength(1)
    await h.dispose()
    h.events.close()
  })

  test("提醒总数上限 2 次", async () => {
    tempState()
    process.env.SUPERAGENT_STATUS_RECONCILE_MS = "80"
    const h = await setup({
      sessions: [
        rootSession,
        childSession({ id: "ses_c1", outcome: null, time: { created: 1, busy: 2 } }),
        childSession({ id: "ses_c2", outcome: null, time: { created: 1, busy: 2 } }),
        childSession({ id: "ses_c3", outcome: null, time: { created: 1, busy: 2 } }),
      ],
      result: (input: any) => ({
        output: "done",
        metadata: { sessionID: `ses_c${input.description}`, status: "running" },
      }),
    })
    for (const index of [1, 2, 3]) {
      await dispatch(h, { background: true, description: String(index) }, `call-${index}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    for (const id of ["ses_c1", "ses_c2", "ses_c3"]) {
      const child = h.sessions.get(id)!
      child.outcome = "succeeded"
      child.time = { created: 1, busy: 2, idle: 3 }
    }
    await waitFor(() => h.synthetics.length >= 2, 4000)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(h.synthetics).toHaveLength(2)
    await h.dispose()
    h.events.close()
  })

  test("dispose 之后不再补发提醒", async () => {
    tempState()
    process.env.SUPERAGENT_STATUS_RECONCILE_MS = "80"
    const h = await setup({
      sessions: [rootSession, childSession({ outcome: null, time: { created: 1, busy: 2 } })],
      result: { output: "done", metadata: { sessionID: "ses_child", status: "running" } },
    })
    await dispatch(h, { background: true })
    await h.dispose()
    const child = h.sessions.get("ses_child")!
    child.outcome = "succeeded"
    child.time = { created: 1, busy: 2, idle: 3 }
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(h.synthetics).toEqual([])
    h.events.close()
  })
})
