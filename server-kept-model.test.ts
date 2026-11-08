/**
 * 保护子会话的模型硬约束（server 侧）：
 *  - steer 到受保护子会话时，显式 `input.model` 或切换 agent 带来的模型变化被拒绝；
 *  - 同模型续跑、未指定模型且不换 agent 的普通 steer 放行；未保护子会话照旧可改模型。
 *  - 限额备用切换跳过受保护子会话：不计失败、不切模型、不强制重试。
 *  - 保护名单读不到时按无保护处理（fail-open），并留 `kept-read-failed` 日志。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import plugin, { detectSteerModelChange, keptModelDenyMessage } from "./server"

const NOW = 1_800_000_000_000
const ROOT_MODEL = { providerID: "acme", id: "flagship", variant: "high" }
const FLASH_MODEL = { providerID: "acme", id: "flash" }

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
  agents?: Record<string, { id: string; name: string; model?: unknown }>
  /** 该会话的指令条目读取抛错：驱动保护名单读取失败的 fail-open 路径。 */
  failEntriesFor?: string
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
  const hooks: Record<string, any> = {}
  const switchModelCalls: Array<{ sessionID: string; model: any }> = []
  const events = eventQueue()

  const ctx = {
    tool: {
      hook: async (name: string, handler: any) => {
        hooks[`tool:${name}`] = handler
        return { dispose() {} }
      },
    },
    event: { subscribe: () => events.iterable },
    skill: {
      transform: async (callback: any) => {
        callback({ get: () => undefined, add: () => {} })
        return { dispose() {} }
      },
    },
    agent: {
      async get({ agentID }: { agentID: string }) {
        const found = options.agents?.[agentID]
        return { data: found ?? { id: agentID, name: agentID } }
      },
    },
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
          .map((session) => structuredClone(session))
        return { data }
      },
      async update() {},
      async remove() {},
      async prompt() {
        return { id: "msg_1" }
      },
      async context() {
        return []
      },
      async create() {
        throw new Error("not used")
      },
      async switchModel(input: { sessionID: string; model: any }) {
        switchModelCalls.push(structuredClone(input))
      },
      instructions: {
        entry: {
          async list({ sessionID }: { sessionID: string }) {
            if (options.failEntriesFor === sessionID) throw new Error("instructions down")
            return structuredClone(options.entries?.[sessionID] ?? [])
          },
          async put() {},
          async remove() {},
        },
      },
    },
  }
  return { ctx, hooks, sessions, switchModelCalls, events }
}

const cleanups: string[] = []

function tempState() {
  const dir = mkdtempSync(path.join(tmpdir(), "superagent-kept-model-"))
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

async function setup(options: HarnessOptions) {
  const h = harness(options)
  const dispose = await (plugin as any).setup(h.ctx)
  return { ...h, dispose }
}

async function denied(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
    throw new Error("expected denial")
  } catch (cause) {
    return cause
  }
}

function call(id: string, input: Record<string, unknown> = {}) {
  return {
    tool: "subagent",
    sessionID: "ses_root",
    id,
    agent: "superagent",
    input: { agent: "worker", description: "task", prompt: "do it", ...input },
  }
}

const rootEntries = (extra: Entry[] = []): Entry[] => [
  { key: "superagent.max-subagents", value: 5 },
  { key: "superagent.fallback-threshold", value: 3 },
  { key: "superagent.fallback-model", value: "acme/backup" },
  { key: "superagent.subagent-fallback-model", value: "acme/backup" },
  ...extra,
]

function sessions(childModel: unknown = ROOT_MODEL, childAgent = "worker"): FakeSession[] {
  return [
    { id: "ses_root", title: "root", agent: "superagent", model: ROOT_MODEL },
    {
      id: "ses_child",
      parentID: "ses_root",
      agent: childAgent,
      model: childModel,
      outcome: "succeeded",
      time: { created: 1 },
    },
  ]
}

const quotaError = { message: "429 rate limit exceeded" }

describe("detectSteerModelChange", () => {
  test("显式 model 不同即会改模型", () => {
    const change = detectSteerModelChange({
      explicitModel: "acme/flash",
      switched: false,
      existingModel: ROOT_MODEL,
    })
    expect(change?.from).toBe("acme/flagship#high")
    expect(change?.to).toBe("acme/flash")
  })

  test("显式 model 完全相同即不改模型", () => {
    expect(
      detectSteerModelChange({
        explicitModel: "acme/flagship#high",
        switched: false,
        existingModel: ROOT_MODEL,
      }),
    ).toBeUndefined()
  })

  test("显式 default variant 与缺省 variant 相同即不改模型", () => {
    const existingModel = { providerID: "acme", id: "flagship" }
    expect(
      detectSteerModelChange({ explicitModel: "acme/flagship#default", switched: false, existingModel }),
    ).toBeUndefined()
    expect(
      detectSteerModelChange({
        explicitModel: "acme/flagship",
        switched: false,
        existingModel: { ...existingModel, variant: "default" },
      }),
    ).toBeUndefined()
  })

  test("切换 agent 时 agent.model 生效", () => {
    const change = detectSteerModelChange({
      agentModel: FLASH_MODEL,
      switched: true,
      existingModel: ROOT_MODEL,
    })
    expect(change?.to).toBe("acme/flash")
  })

  test("切换 agent 但模型相同即不改模型", () => {
    expect(
      detectSteerModelChange({
        agentModel: ROOT_MODEL,
        switched: true,
        existingModel: ROOT_MODEL,
      }),
    ).toBeUndefined()
  })

  test("未指定模型且不换 agent：保持原模型", () => {
    expect(detectSteerModelChange({ switched: false, existingModel: ROOT_MODEL })).toBeUndefined()
  })

  test("现有模型读不出来时按会改处理", () => {
    const change = detectSteerModelChange({ explicitModel: "acme/flash", switched: false })
    expect(change?.from).toBeUndefined()
    expect(change?.to).toBe("acme/flash")
  })

  test("拒绝文案提示先取消保护", () => {
    const message = keptModelDenyMessage({ sessionID: "ses_child", from: "acme/flash", to: "acme/flagship#high" })
    expect(message).toContain("模型不可修改")
    expect(message).toContain("取消")
    expect(message).toContain("ses_child")
  })
})

describe("受保护子会话的模型硬约束", () => {
  test("kept 子会话显式改模型被拒绝", async () => {
    tempState()
    const h = await setup({
      sessions: sessions(),
      entries: { ses_root: rootEntries([{ key: "superagent.kept-subagents", value: "ses_child" }]) },
    })
    const error = await denied(
      h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", model: "acme/flash" })),
    )
    expect(String(error.message)).toContain("模型不可修改")
    expect(String(error.message)).toContain("取消")
    const row = hookLog().find((record) => record.event === "kept-model-denied")
    expect(row?.reason).toBe("kept-model-locked")
    expect(row?.steerTarget).toBe("ses_child")
    await h.dispose()
    h.events.close()
  })

  test("kept 子会话切换 agent 带来的隐式改模型被拒绝", async () => {
    tempState()
    const h = await setup({
      sessions: sessions(),
      entries: { ses_root: rootEntries([{ key: "superagent.kept-subagents", value: "ses_child" }]) },
      agents: {
        worker: { id: "worker", name: "worker", model: ROOT_MODEL },
        other: { id: "other", name: "other", model: FLASH_MODEL },
      },
    })
    const error = await denied(
      h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", agent: "other" })),
    )
    expect(String(error.message)).toContain("模型不可修改")
    const row = hookLog().find((record) => record.event === "kept-model-denied")
    expect(row?.to).toBe("acme/flash")
    await h.dispose()
    h.events.close()
  })

  test("kept 子会话同模型 steer 放行", async () => {
    tempState()
    const h = await setup({
      sessions: sessions(),
      entries: { ses_root: rootEntries([{ key: "superagent.kept-subagents", value: "ses_child" }]) },
    })
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", model: "acme/flagship#high" }))
    expect(hookLog().some((record) => record.event === "kept-model-denied")).toBe(false)
    expect(hookLog().some((record) => record.event === "subagent-steer")).toBe(true)
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "steer1" })
    await h.dispose()
    h.events.close()
  })

  test("kept 子会话 default variant 等价的同模型 steer 放行", async () => {
    tempState()
    const h = await setup({
      sessions: sessions({ providerID: "acme", id: "flagship", variant: "default" }),
      entries: { ses_root: rootEntries([{ key: "superagent.kept-subagents", value: "ses_child" }]) },
    })
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", model: "acme/flagship" }))
    expect(hookLog().some((record) => record.event === "kept-model-denied")).toBe(false)
    expect(hookLog().some((record) => record.event === "subagent-steer")).toBe(true)
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "steer1" })
    await h.dispose()
    h.events.close()
  })

  test("kept 子会话未指定模型、不换 agent 的普通 steer 放行", async () => {
    tempState()
    const h = await setup({
      sessions: sessions(),
      entries: { ses_root: rootEntries([{ key: "superagent.kept-subagents", value: "ses_child" }]) },
    })
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child" }))
    expect(hookLog().some((record) => record.event === "kept-model-denied")).toBe(false)
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "steer1" })
    await h.dispose()
    h.events.close()
  })

  test("未保护的子会话可以改模型", async () => {
    tempState()
    const h = await setup({
      sessions: sessions(),
      entries: { ses_root: rootEntries() },
    })
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", model: "acme/flash" }))
    expect(hookLog().some((record) => record.event === "kept-model-denied")).toBe(false)
    expect(hookLog().some((record) => record.event === "subagent-steer")).toBe(true)
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "steer1" })
    await h.dispose()
    h.events.close()
  })

  test("保护名单读取失败：按无保护处理（fail-open）并留日志", async () => {
    tempState()
    const h = await setup({
      sessions: sessions(FLASH_MODEL),
      entries: { ses_root: rootEntries([{ key: "superagent.kept-subagents", value: "ses_child" }]) },
      failEntriesFor: "ses_root",
    })
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", model: "acme/other" }))
    expect(hookLog().some((record) => record.event === "kept-read-failed")).toBe(true)
    expect(hookLog().some((record) => record.event === "kept-model-denied")).toBe(false)
    await h.dispose()
    h.events.close()
  })
})

describe("限额备用切换与保护名单", () => {
  test("kept 子会话限额失败：不切模型、不强制重试、不计失败", async () => {
    tempState()
    const h = await setup({
      sessions: sessions(),
      entries: { ses_root: rootEntries([{ key: "superagent.kept-subagents", value: "ses_child" }]) },
    })
    const decisions: any[] = []
    for (let index = 0; index < 3; index += 1) {
      const event: any = { sessionID: "ses_child", error: quotaError, model: ROOT_MODEL, decision: { retry: false } }
      await h.hooks["session:retry"](event)
      decisions.push(event.decision)
    }
    expect(h.switchModelCalls).toHaveLength(0)
    expect(decisions).toEqual([{ retry: false }, { retry: false }, { retry: false }])
    expect(hookLog().some((record) => record.event === "fallback-kept-model")).toBe(true)
    await h.dispose()
    h.events.close()
  })

  test("未保护的子会话限额失败：照常切到备用模型并翻成重试", async () => {
    tempState()
    const h = await setup({
      sessions: sessions(),
      entries: { ses_root: rootEntries() },
    })
    const event: any = { sessionID: "ses_child", error: quotaError, model: ROOT_MODEL, decision: { retry: false } }
    for (let index = 0; index < 3; index += 1) {
      await h.hooks["session:retry"](event)
    }
    expect(h.switchModelCalls).toHaveLength(1)
    expect(h.switchModelCalls[0].sessionID).toBe("ses_child")
    expect(`${h.switchModelCalls[0].model.providerID}/${h.switchModelCalls[0].model.id}`).toBe("acme/backup")
    expect(event.decision).toEqual({ retry: true, delay: 1000 })
    expect(hookLog().some((record) => record.event === "fallback-kept-model")).toBe(false)
    await h.dispose()
    h.events.close()
  })

  test("保护名单读取失败：限额路径照常切换（fail-open）", async () => {
    tempState()
    const h = await setup({
      sessions: sessions(),
      entries: { ses_root: rootEntries([{ key: "superagent.kept-subagents", value: "ses_child" }]) },
      failEntriesFor: "ses_child",
    })
    const event: any = { sessionID: "ses_child", error: quotaError, model: ROOT_MODEL, decision: { retry: false } }
    for (let index = 0; index < 3; index += 1) {
      await h.hooks["session:retry"](event)
    }
    expect(hookLog().some((record) => record.event === "kept-read-failed")).toBe(true)
    expect(h.switchModelCalls).toHaveLength(1)
    expect(event.decision).toEqual({ retry: true, delay: 1000 })
    await h.dispose()
    h.events.close()
  })
})
