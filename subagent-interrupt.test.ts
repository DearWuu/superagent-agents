/**
 * 原生 subagent 续跑默认排队、显式 interrupt:true 才抢占的接线与边界：
 * schema 追加 interrupt、默认不中断、显式 true 才先停后投递、
 * interrupt:false / idle / 新建透传、失败与取消明确抛错。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

import plugin, { interruptBeforeSubagentSteer } from "./server"

const cleanups: string[] = []

function tempState() {
  const dir = mkdtempSync(path.join(tmpdir(), "superagent-interrupt-"))
  cleanups.push(dir)
  process.env.SUPERAGENT_STATE_DIR = dir
  process.env.XDG_STATE_HOME = dir
  process.env.SUPERAGENT_HOOK_LOG = path.join(dir, "hook.log")
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
  delete process.env.SUPERAGENT_STATE_DIR
  delete process.env.XDG_STATE_HOME
  delete process.env.SUPERAGENT_HOOK_LOG
})

type FakeSession = {
  id: string
  parentID?: string
  time?: { created?: number; busy?: number; idle?: number }
  outcome?: string | null
}

type HarnessOptions = {
  sessions: FakeSession[]
  /** 覆盖原生工具 input，用于模拟无法扩展 schema 的宿主。 */
  input?: any
  /** interrupt 调用是否让会话真正停下；false 用于模拟中断未生效。 */
  stopsOnInterrupt?: boolean
  interruptError?: Error
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function harness(options: HarnessOptions) {
  const sessions = new Map<string, FakeSession>()
  for (const session of options.sessions) sessions.set(session.id, structuredClone(session))
  const calls: string[] = []
  const executions: any[] = []
  const hooks: Record<string, any> = {}
  const transformCallbacks: Array<(editor: any) => void> = []
  const interrupted = deferred()

  const tool: any = {
    id: "subagent",
    name: "subagent",
    description: "native subagent",
    input:
      options.input ??
      Schema.Struct({
        agent: Schema.String,
        prompt: Schema.String,
        model: Schema.optional(Schema.String),
        sessionID: Schema.optional(Schema.String),
        background: Schema.optional(Schema.Boolean),
      }),
    execute: async (input: any) => {
      calls.push("execute")
      executions.push(structuredClone(input))
      return { output: "done" }
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
    event: {
      subscribe: () => (async function* () {})(),
    },
    agent: {
      get: async ({ agentID }: { agentID: string }) => ({ data: { id: agentID, name: agentID } }),
    },
    model: {
      list: async () => ({ data: [] }),
    },
    session: {
      hook: async (name: string, handler: any) => {
        hooks[`session:${name}`] = handler
        return { dispose() {} }
      },
      async get({ sessionID }: { sessionID: string }) {
        const found = sessions.get(sessionID)
        if (!found) throw new Error(`no session ${sessionID}`)
        const running =
          found.time?.busy !== undefined &&
          (found.time.idle === undefined || found.time.busy > found.time.idle)
        calls.push(running ? "get:running" : "get:idle")
        return structuredClone(found)
      },
      async interrupt({ sessionID }: { sessionID: string }) {
        calls.push("interrupt")
        if (options.interruptError) throw options.interruptError
        if (options.stopsOnInterrupt === false) {
          interrupted.resolve()
          return {}
        }
        const found = sessions.get(sessionID)
        if (found) {
          const busy = found.time?.busy ?? 1
          found.time = { ...found.time, busy, idle: busy + 1 }
        }
        interrupted.resolve()
        return {}
      },
      async list() {
        return { data: [...sessions.values()].map((session) => structuredClone(session)) }
      },
      async update() {},
      async remove() {},
      async prompt() {},
      async context() {
        return []
      },
      async create() {
        throw new Error("not used")
      },
      async switchModel() {},
      instructions: {
        entry: {
          async list() {
            return []
          },
          async put() {},
          async remove() {},
        },
      },
    },
  }

  const applyToolTransforms = () => {
    for (const callback of transformCallbacks) callback(editor())
  }

  return { ctx, tool, calls, executions, hooks, interrupted, applyToolTransforms }
}

async function setup(options: HarnessOptions) {
  tempState()
  const h = harness(options)
  const dispose = await (plugin as any).setup(h.ctx)
  return { ...h, dispose }
}

function steerInput(extra: Record<string, unknown> = {}) {
  return { agent: "worker", prompt: "continue", sessionID: "ses_child", ...extra }
}

async function rejected(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
    throw new Error("expected rejection")
  } catch (cause) {
    return cause
  }
}

describe("subagent interrupt schema", () => {
  test("原生 schema 追加可选 interrupt，旧输入仍可解析", async () => {
    const h = await setup({ sessions: [] })
    const input = h.tool.input
    expect(Object.keys(input.fields)).toContain("interrupt")
    expect(Schema.decodeUnknownSync(input)({ agent: "worker", prompt: "new" })).toEqual({
      agent: "worker",
      prompt: "new",
    })
    expect(Schema.decodeUnknownSync(input)({ agent: "worker", prompt: "go", interrupt: false }).interrupt).toBe(false)
    expect(() => Schema.decodeUnknownSync(input)({ agent: "worker", prompt: "go", interrupt: "no" })).toThrow()
    await h.dispose()
  })

  test("schema 无法扩展时不包装，保留原生 steer", async () => {
    const h = await setup({
      sessions: [{ id: "ses_child", time: { created: 1, busy: 2 } }],
      input: Schema.String,
    })
    const input = steerInput({ interrupt: false })
    await h.tool.execute(input, { signal: new AbortController().signal })
    expect(h.calls).toEqual(["execute"])
    expect(h.executions).toEqual([input])
    await h.dispose()
  })
})

describe("subagent 续跑默认排队", () => {
  test("默认续跑不抢占：不查询、不中断，原生 execute 收到去掉 interrupt 的输入", async () => {
    const h = await setup({
      sessions: [{ id: "ses_child", time: { created: 1, busy: 2 } }],
    })
    await h.tool.execute(steerInput(), { signal: new AbortController().signal })
    expect(h.calls).toEqual(["execute"])
    expect(h.executions).toEqual([{ agent: "worker", prompt: "continue", sessionID: "ses_child" }])
    await h.dispose()
  })

  test("默认续跑显式 interrupt:false：同样不查询、不中断", async () => {
    const h = await setup({
      sessions: [{ id: "ses_child", time: { created: 1, busy: 2 } }],
    })
    await h.tool.execute(steerInput({ interrupt: false }), { signal: new AbortController().signal })
    expect(h.calls).toEqual(["execute"])
    expect(h.executions).toEqual([{ agent: "worker", prompt: "continue", sessionID: "ses_child" }])
    await h.dispose()
  })

  test("显式 interrupt:true：get→interrupt→确认 idle→投递，且不把 interrupt 传给宿主", async () => {
    const h = await setup({
      sessions: [{ id: "ses_child", time: { created: 1, busy: 2 } }],
    })
    await h.tool.execute(steerInput({ interrupt: true }), { signal: new AbortController().signal })
    expect(h.calls).toEqual(["get:running", "interrupt", "get:idle", "execute"])
    expect(h.executions).toEqual([{ agent: "worker", prompt: "continue", sessionID: "ses_child" }])
    await h.dispose()
  })

  test("宿主重复应用 transform 不会重复包 execute：显式 true 仍只中断一次", async () => {
    const h = await setup({
      sessions: [{ id: "ses_child", time: { created: 1, busy: 2 } }],
    })
    h.applyToolTransforms()
    h.applyToolTransforms()
    await h.tool.execute(steerInput({ interrupt: true }), { signal: new AbortController().signal })
    expect(h.calls).toEqual(["get:running", "interrupt", "get:idle", "execute"])
    expect(h.executions).toEqual([{ agent: "worker", prompt: "continue", sessionID: "ses_child" }])
    await h.dispose()
  })

  test("宿主重复应用 transform 后默认续跑仍不抢占", async () => {
    const h = await setup({
      sessions: [{ id: "ses_child", time: { created: 1, busy: 2 } }],
    })
    h.applyToolTransforms()
    h.applyToolTransforms()
    await h.tool.execute(steerInput(), { signal: new AbortController().signal })
    expect(h.calls).toEqual(["execute"])
    expect(h.executions).toEqual([{ agent: "worker", prompt: "continue", sessionID: "ses_child" }])
    await h.dispose()
  })

  test("宿主重复应用 transform 后 interrupt:false 仍保持原生 steer", async () => {
    const h = await setup({
      sessions: [{ id: "ses_child", time: { created: 1, busy: 2 } }],
    })
    h.applyToolTransforms()
    h.applyToolTransforms()
    await h.tool.execute(steerInput({ interrupt: false }), { signal: new AbortController().signal })
    expect(h.calls).toEqual(["execute"])
    expect(h.executions).toEqual([{ agent: "worker", prompt: "continue", sessionID: "ses_child" }])
    await h.dispose()
  })

  test("idle 子会话不做多余中断", async () => {
    const h = await setup({
      sessions: [{ id: "ses_child", time: { created: 1, busy: 2, idle: 3 } }],
    })
    await h.tool.execute(steerInput({ interrupt: true }), { signal: new AbortController().signal })
    expect(h.calls).toEqual(["get:idle", "execute"])
    await h.dispose()
  })

  test("新建子代理不受影响", async () => {
    const h = await setup({ sessions: [] })
    await h.tool.execute({ agent: "worker", prompt: "new" }, { signal: new AbortController().signal })
    expect(h.calls).toEqual(["execute"])
    await h.dispose()
  })

  test("interrupt 失败明确报错且不投递", async () => {
    const h = await setup({
      sessions: [{ id: "ses_child", time: { created: 1, busy: 2 } }],
      interruptError: new Error("host refused"),
    })
    const error = await rejected(h.tool.execute(steerInput({ interrupt: true }), { signal: new AbortController().signal }))
    expect(String(error.message)).toContain("中断子会话 ses_child 失败")
    expect(String(error.message)).toContain("host refused")
    expect(h.calls).toEqual(["get:running", "interrupt"])
    expect(h.executions).toEqual([])
    await h.dispose()
  })

  test("调用已取消时不查询、不中断、不投递", async () => {
    const h = await setup({
      sessions: [{ id: "ses_child", time: { created: 1, busy: 2 } }],
    })
    const controller = new AbortController()
    controller.abort()
    const error = await rejected(h.tool.execute(steerInput(), { signal: controller.signal }))
    expect(String(error.message)).toContain("续跑投递已取消")
    expect(h.calls).toEqual([])
    await h.dispose()
  })

  test("等待停止期间取消：不投递并保留取消原因", async () => {
    const h = await setup({
      sessions: [{ id: "ses_child", time: { created: 1, busy: 2 } }],
      stopsOnInterrupt: false,
    })
    const controller = new AbortController()
    const pending = h.tool.execute(steerInput({ interrupt: true }), { signal: controller.signal })
    await h.interrupted.promise
    controller.abort()
    const error = await rejected(pending)
    expect(String(error.message)).toContain("续跑投递已取消")
    expect(h.executions).toEqual([])
    await h.dispose()
  })
})

describe("interruptBeforeSubagentSteer 超时", () => {
  test("中断后始终未停止时明确超时，不假装成功", async () => {
    const error = await rejected(
      interruptBeforeSubagentSteer(
        {
          getSession: async () => ({ id: "ses_child", time: { created: 1, busy: 2 } }),
          interrupt: async () => undefined,
          now: () => 0,
          sleep: async () => undefined,
          timeoutMs: 0,
        },
        "ses_child",
      ),
    )
    expect(String(error.message)).toContain("等待停止超时（0ms）")
  })

  test("读取目标状态失败时明确报错", async () => {
    const error = await rejected(
      interruptBeforeSubagentSteer(
        {
          getSession: async () => {
            throw new Error("not found")
          },
          interrupt: async () => undefined,
        },
        "ses_missing",
      ),
    )
    expect(String(error.message)).toContain("读取子会话 ses_missing 状态失败")
    expect(String(error.message)).toContain("not found")
  })
})
