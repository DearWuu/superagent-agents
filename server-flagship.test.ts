/**
 * 旗舰硬上限的真实接线：用假 ctx 驱动真实 `setup()` 的 `execute.before`/`execute.after`
 * 与事件订阅，覆盖默认/0/非法上限、显式模型判定、总上限共同约束、在途并发、
 * steer 切换、显式标记写入/清理与淘汰保护。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import plugin from "./server"
import { FLAGSHIP_MARKER_SOURCE, FLAGSHIP_METADATA_KEY, MAX_FLAGSHIP_SUBAGENTS_KEY } from "./flagship-admission"
import { MODEL_DELEGATION_MARKER_SOURCE, MODEL_DELEGATION_METADATA_KEY } from "./model-delegation"

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
  models?: any[]
  barrier?: boolean
  /** 第 2 次读取指令条目时抛错：驱动 lookup-failed 的还槽路径。 */
  failSecondEntryList?: boolean
  /** remove 一律失败且不删会话：驱动淘汰真实失败路径。 */
  failRemove?: boolean
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
  const updates: Array<{ sessionID: string; metadata?: Record<string, unknown> }> = []
  const removed: string[] = []
  const prompts: Array<{ sessionID: string; text?: string }> = []
  const events = eventQueue()
  const addedSkills: Array<{ id: string; path: string }> = []

  let entryListCalls = 0
  let barrierCalls = 0
  let releaseBarrier: (() => void) | undefined
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve
  })

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
        const editor = {
          get: (id: string) => addedSkills.find((skill) => skill.id === id),
          add: (skill: any) => addedSkills.push({ id: skill.id, path: skill.path }),
        }
        callback(editor)
        return { dispose() {} }
      },
    },
    agent: {
      async get({ agentID }: { agentID: string }) {
        const found = options.agents?.[agentID]
        return { data: found ?? { id: agentID, name: agentID } }
      },
    },
    model: {
      async list() {
        return { data: options.models ?? [] }
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
        if (options.barrier && barrierCalls < 2) {
          barrierCalls++
          if (barrierCalls === 2) releaseBarrier?.()
          await barrier
        }
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
        if (options.failRemove) throw new Error("remove failed")
        // 与宿主一致：删一个已不存在（被并发调用删掉）的会话返回 NotFound。
        if (!sessions.has(sessionID)) throw new Error(`session not found: ${sessionID}`)
        removed.push(sessionID)
        sessions.delete(sessionID)
      },
      async prompt(input: { sessionID: string; text?: string }) {
        prompts.push(input)
        return { id: `msg_${prompts.length}` }
      },
      async context() {
        return []
      },
      async create() {
        throw new Error("not used")
      },
      async switchModel() {},
      instructions: {
        entry: {
          async list({ sessionID }: { sessionID: string }) {
            entryListCalls++
            if (options.failSecondEntryList && entryListCalls === 2) throw new Error("instructions down")
            return structuredClone(options.entries?.[sessionID] ?? [])
          },
          async put() {},
          async remove() {},
        },
      },
    },
  }
  return { ctx, hooks, sessions, updates, removed, prompts, events, addedSkills }
}

const cleanups: string[] = []

function tempState() {
  const dir = mkdtempSync(path.join(tmpdir(), "superagent-flagship-"))
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

const rootEntries = (extra: Entry[] = []): Entry[] => [
  { key: "superagent.max-subagents", value: 5 },
  ...extra,
]

function baseSessions(children: FakeSession[] = []): FakeSession[] {
  return [{ id: "ses_root", title: "root", agent: "superagent", model: ROOT_MODEL }, ...children]
}

/** 显式旗舰委派成功后写在 child 自身 metadata 的标记（带显式来源）。 */
const flagshipMarker = { [FLAGSHIP_METADATA_KEY]: { model: ROOT_MODEL, at: 1, source: FLAGSHIP_MARKER_SOURCE } }

/** 旧版本按模型相等自动写入的 `{ model, at }` 标记：无来源，不证明显式委派。 */
const legacyAutoMarker = { [FLAGSHIP_METADATA_KEY]: { model: ROOT_MODEL, at: 1 } }

function finishedFlagship(id: string, created: number): FakeSession {
  return {
    id,
    parentID: "ses_root",
    agent: "worker",
    model: ROOT_MODEL,
    metadata: structuredClone(flagshipMarker),
    outcome: "succeeded",
    time: { created },
  }
}

function runningFlagship(id: string, created = NOW - 1000): FakeSession {
  return {
    id,
    parentID: "ses_root",
    agent: "worker",
    model: ROOT_MODEL,
    metadata: structuredClone(flagshipMarker),
    outcome: null,
    time: { created, busy: created },
  }
}

/** 与 root 同模型但无标记的普通子代理：不占旗舰名额。 */
function plainSameModel(id: string, created: number, running = false): FakeSession {
  return {
    id,
    parentID: "ses_root",
    agent: "worker",
    model: ROOT_MODEL,
    outcome: running ? null : "succeeded",
    time: running ? { created, busy: created } : { created },
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

async function denied(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
    throw new Error("expected denial")
  } catch (cause) {
    return cause
  }
}

async function setup(options: HarnessOptions) {
  const h = harness(options)
  const dispose = await (plugin as any).setup(h.ctx)
  return { ...h, dispose }
}

describe("旗舰上限默认与配置", () => {
  test("默认 2：两个运行中的旗舰占满后，第三个旗舰被拒绝", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([runningFlagship("ses_f1", 10), runningFlagship("ses_f2", 20)]),
      entries: { ses_root: rootEntries() },
    })
    const error = await denied(h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" })))
    expect(String(error.message)).toContain("旗舰子代理上限已满")
    expect(String(error.message)).toContain("上限2")
    expect(h.removed).toEqual([])
    const row = hookLog().find((record) => record.event === "subagent-denied")
    expect(row.reason).toBe("flagship-limit")
    expect(row.flagshipExist).toBe(2)
    expect(row.flagshipLimit).toBe(2)
    await h.dispose()
    h.events.close()
  })

  test("超过上限时优先淘汰最旧的已完成旗舰", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([finishedFlagship("ses_old", 10), finishedFlagship("ses_new", 20)]),
      entries: { ses_root: rootEntries() },
    })
    await h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" }))
    expect(h.removed).toEqual(["ses_old"])
    expect(hookLog().some((record) => record.event === "flagship-evict" && record.victim === "ses_old")).toBe(true)
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c1" })
    await h.dispose()
    h.events.close()
  })

  test("0 禁止显式旗舰；继承/agent 默认/root 同模型的普通子代理不受限", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions(),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 0 }]) },
    })
    // 显式 input.model = root 同款：拒绝。
    const error = await denied(h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" })))
    expect(String(error.message)).toContain("旗舰子代理上限已满")
    // 无 input 继承 root 模型：普通子代理，放行。
    await h.hooks["tool:execute.before"](call("c2"))
    // agent.model = root 同款但无显式 input：普通子代理，放行。
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c2" })
    const agentH = await setup({
      sessions: baseSessions(),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 0 }]) },
      agents: { worker: { id: "worker", name: "worker", model: ROOT_MODEL } },
    })
    await agentH.hooks["tool:execute.before"](call("c3"))
    await agentH.hooks["tool:execute.after"]({ tool: "subagent", id: "c3" })
    // 普通显式 Flash：放行。
    await h.hooks["tool:execute.before"](call("c4", { model: "acme/flash" }))
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c4" })
    await h.dispose()
    await agentH.dispose()
    h.events.close()
    agentH.events.close()
  })

  test("root 从 Flash 切到旗舰后，无标记的同模型普通子代理不计数、不淘汰", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        plainSameModel("ses_p1", 10),
        plainSameModel("ses_p2", 20),
        plainSameModel("ses_p3", 30),
      ]),
      entries: { ses_root: rootEntries() },
    })
    // 显式旗舰新建：无标记普通子代理不占旗舰名额（exist=0 < limit=2），无需淘汰。
    await h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" }))
    expect(h.removed).toEqual([])
    const row = hookLog().find((record) => record.event === "subagent-allowed")
    expect(row.flagship).toBe(true)
    expect(row.flagshipExist).toBe(0)
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "c1",
      status: "completed",
      result: { metadata: { sessionID: "ses_new", status: "completed" } },
    })
    // 成功的显式旗舰才写标记；普通子代理仍无标记。
    const marked = hookLog().filter((record) => record.event === "flagship-marked")
    expect(marked.map((record) => record.sessionID)).toEqual(["ses_new"])
    await h.dispose()
    h.events.close()
  })

  test("非法值回退默认 2", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([runningFlagship("ses_f1")]),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: "abc" }]) },
    })
    await h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" }))
    const row = hookLog().find((record) => record.event === "subagent-allowed")
    expect(row.flagshipLimit).toBe(2)
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c1" })
    await h.dispose()
    h.events.close()
  })
})

describe("旗舰模型判定（只认显式 input.model）", () => {
  const cases: Array<{ name: string; input: Record<string, unknown>; agents?: HarnessOptions["agents"]; flagship: boolean }> = [
    { name: "显式同款模型", input: { model: "acme/flagship#high" }, flagship: true },
    { name: "未指定时继承 parent 模型不算旗舰", input: {}, flagship: false },
    {
      name: "agent 配置的同款模型但无显式 input 不算旗舰",
      input: {},
      agents: { worker: { id: "worker", name: "worker", model: ROOT_MODEL } },
      flagship: false,
    },
    { name: "variant 不同不算旗舰", input: { model: "acme/flagship#low" }, flagship: false },
    { name: "缺 variant 不算旗舰", input: { model: "acme/flagship" }, flagship: false },
    { name: "不同模型不算旗舰", input: { model: "acme/flash" }, flagship: false },
  ]

  for (const item of cases) {
    test(item.name, async () => {
      tempState()
      const h = await setup({
        sessions: baseSessions(),
        entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 0 }]) },
        agents: item.agents,
      })
      const promise = h.hooks["tool:execute.before"](call("c1", item.input))
      if (item.flagship) {
        expect(String((await denied(promise)).message)).toContain("旗舰子代理上限已满")
      } else {
        await promise
        await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c1" })
      }
      await h.dispose()
      h.events.close()
    })
  }
})

describe("总上限与并发", () => {
  test("总上限更小时总上限优先", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_normal",
          parentID: "ses_root",
          agent: "worker",
          model: FLASH_MODEL,
          outcome: null,
          time: { created: NOW - 1000, busy: NOW - 500 },
        },
      ]),
      entries: {
        ses_root: [
          { key: "superagent.max-subagents", value: 1 },
          { key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 2 },
        ],
      },
    })
    const error = await denied(h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" })))
    expect(String(error.message)).toContain("Subagent 存在上限已满")
    const row = hookLog().find((record) => record.event === "subagent-denied")
    expect(row.reason).toBe("total-limit")
    await h.dispose()
    h.events.close()
  })

  test("并发在途一起计数：两个同时创建的旗舰只能放行一个", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([runningFlagship("ses_f1")]),
      entries: { ses_root: rootEntries() },
      barrier: true,
    })
    const results = await Promise.allSettled([
      h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" })),
      h.hooks["tool:execute.before"](call("c2", { model: "acme/flagship#high" })),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    // 若在途不计数，两次都会放行；拒绝本身就是并发可见的证据。
    expect(hookLog().some((record) => record.event === "subagent-denied" && record.reason === "flagship-limit")).toBe(true)
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c1" })
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c2" })
    await h.dispose()
    h.events.close()
  })
})

describe("steer 切换旗舰", () => {
  function steerHarness(limit: number, extra: FakeSession[] = []) {
    return setup({
      sessions: baseSessions([
        {
          id: "ses_child",
          parentID: "ses_root",
          agent: "worker",
          model: FLASH_MODEL,
          outcome: "succeeded",
          time: { created: 1 },
        },
        ...extra,
      ]),
      entries: {
        ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: limit }]),
      },
    })
  }

  test("普通 child 切成旗舰必须占旗舰槽，占满则拒绝", async () => {
    tempState()
    const h = await steerHarness(1, [runningFlagship("ses_f1")])
    const error = await denied(
      h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", model: "acme/flagship#high" })),
    )
    expect(String(error.message)).toContain("旗舰子代理上限已满")
    await h.dispose()
    h.events.close()
  })

  test("已经是旗舰的 steer 不重复占槽", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_child",
          parentID: "ses_root",
          agent: "worker",
          model: ROOT_MODEL,
          metadata: structuredClone(flagshipMarker),
          outcome: "succeeded",
          time: { created: 1 },
        },
        runningFlagship("ses_f1"),
      ]),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 1 }]) },
    })
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", model: "acme/flagship#high" }))
    const row = hookLog().find((record) => record.event === "subagent-steer")
    expect(row.alreadyFlagship).toBe(true)
    expect(row.flagshipInflight).toBeNull()
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "steer1" })
    await h.dispose()
    h.events.close()
  })

  test("无显式 model 的普通续跑不占旗舰槽（limit 0 也放行）", async () => {
    tempState()
    const h = await steerHarness(0)
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child" }))
    const row = hookLog().find((record) => record.event === "subagent-steer")
    expect(row.flagship).toBe(false)
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "steer1" })
    await h.dispose()
    h.events.close()
  })

  test("agent 切换带来同模型也不占旗舰槽", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_child",
          parentID: "ses_root",
          agent: "worker",
          model: ROOT_MODEL,
          outcome: "succeeded",
          time: { created: 1 },
        },
      ]),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 0 }]) },
      agents: { researcher: { id: "researcher", name: "researcher", model: ROOT_MODEL } },
    })
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", agent: "researcher" }))
    const row = hookLog().find((record) => record.event === "subagent-steer")
    expect(row.flagship).toBe(false)
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "steer1" })
    await h.dispose()
    h.events.close()
  })

  test("steer 切旗舰时同样优先淘汰最旧已完成旗舰", async () => {
    tempState()
    const h = await steerHarness(1, [finishedFlagship("ses_old", 5)])
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", model: "acme/flagship#high" }))
    expect(h.removed).toEqual(["ses_old"])
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "steer1" })
    await h.dispose()
    h.events.close()
  })
})

describe("持久旗舰标记", () => {
  test("session.created 不再写旗舰标记（同模型普通创建不是旗舰）", async () => {
    tempState()
    const h = await setup({ sessions: baseSessions([{ id: "ses_child", parentID: "ses_root" }]) })
    h.events.push({
      id: "evt_1",
      type: "session.created",
      data: {
        sessionID: "ses_child",
        parentID: "ses_root",
        model: ROOT_MODEL,
        metadata: { keep: 1 },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.updates).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })

  test("child 切走模型清标记；root 切模型不清洗旧 child 标记", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_child",
          parentID: "ses_root",
          model: ROOT_MODEL,
          metadata: { keep: 1, ...structuredClone(flagshipMarker) },
        },
      ]),
    })
    h.events.push({
      id: "evt_2",
      type: "session.model.selected",
      data: { sessionID: "ses_root", model: FLASH_MODEL },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.updates).toHaveLength(0)

    h.events.push({
      id: "evt_3",
      type: "session.model.selected",
      data: { sessionID: "ses_child", model: FLASH_MODEL, previous: ROOT_MODEL },
    })
    expect(await waitFor(() => h.updates.length > 0)).toBe(true)
    expect(h.updates[0].metadata).toEqual({ keep: 1 })
    expect(hookLog().some((record) => record.event === "flagship-cleared")).toBe(true)
    await h.dispose()
    h.events.close()
  })

  test("无标记的 child 切到与 parent 相同模型不新增标记", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([{ id: "ses_child", parentID: "ses_root", model: FLASH_MODEL, metadata: { keep: 1 } }]),
    })
    h.events.push({
      id: "evt_4",
      type: "session.model.selected",
      data: { sessionID: "ses_child", model: ROOT_MODEL, previous: FLASH_MODEL },
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.updates).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })

  test("有标记的 child 保持在标记模型上不清理", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_child",
          parentID: "ses_root",
          model: ROOT_MODEL,
          metadata: structuredClone(flagshipMarker),
        },
      ]),
    })
    h.events.push({
      id: "evt_5",
      type: "session.model.selected",
      data: { sessionID: "ses_child", model: ROOT_MODEL },
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.updates).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })

  test("critic 会话不清理标记", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_critic",
          parentID: "ses_root",
          title: "Critic: 复核 x",
          model: ROOT_MODEL,
          metadata: { "superagent.critic": true, ...structuredClone(flagshipMarker) },
        },
      ]),
    })
    h.events.push({
      id: "evt_6",
      type: "session.model.selected",
      data: { sessionID: "ses_critic", model: FLASH_MODEL },
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.updates).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })
})

describe("显式旗舰标记（tool:execute.after）", () => {
  test("显式旗舰创建成功后按 result.metadata.sessionID 写标记", async () => {
    tempState()
    const h = await setup({ sessions: baseSessions(), entries: { ses_root: rootEntries() } })
    await h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" }))
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "c1",
      status: "completed",
      result: { metadata: { sessionID: "ses_new", status: "completed" } },
    })
    const update = h.updates.find((item) => item.sessionID === "ses_new")
    expect(update?.metadata?.[FLAGSHIP_METADATA_KEY]).toMatchObject({
      model: ROOT_MODEL,
      source: FLAGSHIP_MARKER_SOURCE,
    })
    expect(hookLog().some((record) => record.event === "flagship-marked" && record.sessionID === "ses_new")).toBe(true)
    await h.dispose()
    h.events.close()
  })

  test("after 无 result（旧形态）不写标记、不抛错，槽位照常归还", async () => {
    tempState()
    const h = await setup({ sessions: baseSessions(), entries: { ses_root: rootEntries() } })
    await h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" }))
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c1" })
    expect(h.updates).toHaveLength(0)
    expect(hookLog().some((record) => record.event === "flagship-mark-skip")).toBe(true)
    // 槽位已还：下一个显式旗舰仍可放行。
    await h.hooks["tool:execute.before"](call("c2", { model: "acme/flagship#high" }))
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c2" })
    await h.dispose()
    h.events.close()
  })

  test("工具失败（status=error）不写标记", async () => {
    tempState()
    const h = await setup({ sessions: baseSessions(), entries: { ses_root: rootEntries() } })
    await h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" }))
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "c1",
      status: "error",
      error: { message: "boom" },
    })
    expect(h.updates).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })

  test("后台运行（status=running）的显式旗舰同样写标记", async () => {
    tempState()
    const h = await setup({ sessions: baseSessions(), entries: { ses_root: rootEntries() } })
    await h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" }))
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "c1",
      status: "completed",
      result: { metadata: { sessionID: "ses_bg", status: "running" } },
    })
    expect(h.updates.some((item) => item.sessionID === "ses_bg")).toBe(true)
    await h.dispose()
    h.events.close()
  })

  test("显式旗舰 steer 成功后给目标会话写标记", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_child",
          parentID: "ses_root",
          agent: "worker",
          model: FLASH_MODEL,
          outcome: "succeeded",
          time: { created: 1 },
        },
      ]),
      entries: { ses_root: rootEntries() },
    })
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", model: "acme/flagship#high" }))
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "steer1",
      status: "completed",
      result: { metadata: { sessionID: "ses_child", status: "completed" } },
    })
    const update = h.updates.find((item) => item.sessionID === "ses_child")
    expect(update?.metadata?.[FLAGSHIP_METADATA_KEY]).toMatchObject({
      model: ROOT_MODEL,
      source: FLAGSHIP_MARKER_SOURCE,
    })
    await h.dispose()
    h.events.close()
  })

  test("显式旗舰 steer 失败（status=error）不写标记，槽位照常归还", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_child",
          parentID: "ses_root",
          agent: "worker",
          model: FLASH_MODEL,
          outcome: "succeeded",
          time: { created: 1 },
        },
      ]),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 1 }]) },
    })
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", model: "acme/flagship#high" }))
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "steer1",
      status: "error",
      error: { message: "subagent failed" },
    })
    expect(h.updates).toHaveLength(0)
    expect(hookLog().some((record) => record.event === "flagship-marked")).toBe(false)
    expect(hookLog().some((record) => record.event === "flagship-mark-skip")).toBe(true)
    // 槽位已归还：下一个显式旗舰 steer 不会被拒绝。
    await h.hooks["tool:execute.before"](call("steer2", { sessionID: "ses_child", model: "acme/flagship#high" }))
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "steer2",
      status: "error",
      error: { message: "subagent failed" },
    })
    expect(hookLog().some((record) => record.event === "subagent-denied")).toBe(false)
    expect(h.updates).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })

  test("普通 steer（无显式 model）成功后不写标记", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_child",
          parentID: "ses_root",
          agent: "worker",
          model: ROOT_MODEL,
          outcome: "succeeded",
          time: { created: 1 },
        },
      ]),
      entries: { ses_root: rootEntries() },
    })
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child" }))
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "steer1",
      status: "completed",
      result: { metadata: { sessionID: "ses_child", status: "completed" } },
    })
    expect(h.updates).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })
})

describe("显式模型委派标记（非旗舰 input.model）", () => {
  const delegatedMarker = (model: unknown) => ({
    [MODEL_DELEGATION_METADATA_KEY]: { model, at: 1, source: MODEL_DELEGATION_MARKER_SOURCE },
  })

  test("缺 variant 的显式模型不算旗舰，成功后仍写委派标记", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions(),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 0 }]) },
    })
    // root 是 acme/flagship#high；缺 #high 与 root 不同款，不按旗舰准入。
    await h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship" }))
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "c1",
      status: "completed",
      result: { metadata: { sessionID: "ses_new", status: "completed" } },
    })
    const allowed = hookLog().find((record) => record.event === "subagent-allowed")
    expect(allowed?.flagship).toBe(false)
    const update = h.updates.find((item) => item.sessionID === "ses_new")
    expect(update?.metadata?.[MODEL_DELEGATION_METADATA_KEY]).toMatchObject({
      model: { providerID: "acme", id: "flagship" },
      source: MODEL_DELEGATION_MARKER_SOURCE,
    })
    expect(update?.metadata?.[FLAGSHIP_METADATA_KEY]).toBeUndefined()
    expect(
      hookLog().some((record) => record.event === "model-delegation-marked" && record.sessionID === "ses_new"),
    ).toBe(true)
    await h.dispose()
    h.events.close()
  })

  test("非旗舰显式模型（MiniMax）同样写委派标记", async () => {
    tempState()
    const h = await setup({ sessions: baseSessions(), entries: { ses_root: rootEntries() } })
    await h.hooks["tool:execute.before"](call("c1", { model: "minimax/MiniMax-M2" }))
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "c1",
      status: "completed",
      result: { metadata: { sessionID: "ses_new", status: "completed" } },
    })
    const update = h.updates.find((item) => item.sessionID === "ses_new")
    expect(update?.metadata?.[MODEL_DELEGATION_METADATA_KEY]).toMatchObject({
      model: { providerID: "minimax", id: "MiniMax-M2" },
      source: MODEL_DELEGATION_MARKER_SOURCE,
    })
    expect(update?.metadata?.[FLAGSHIP_METADATA_KEY]).toBeUndefined()
    await h.dispose()
    h.events.close()
  })

  test("无显式 input.model 不写委派标记", async () => {
    tempState()
    const h = await setup({ sessions: baseSessions(), entries: { ses_root: rootEntries() } })
    await h.hooks["tool:execute.before"](call("c1"))
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "c1",
      status: "completed",
      result: { metadata: { sessionID: "ses_new", status: "completed" } },
    })
    expect(h.updates).toHaveLength(0)
    expect(hookLog().some((record) => record.event === "model-delegation-marked")).toBe(false)
    await h.dispose()
    h.events.close()
  })

  test("status=error 或无 sessionID 不写委派标记", async () => {
    tempState()
    const h = await setup({ sessions: baseSessions(), entries: { ses_root: rootEntries() } })
    await h.hooks["tool:execute.before"](call("c1", { model: "minimax/MiniMax-M2" }))
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "c1",
      status: "error",
      error: { message: "boom" },
    })
    expect(h.updates).toHaveLength(0)

    await h.hooks["tool:execute.before"](call("c2", { model: "minimax/MiniMax-M2" }))
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c2", status: "completed" })
    expect(h.updates).toHaveLength(0)
    expect(hookLog().filter((record) => record.event === "model-delegation-mark-skip")).toHaveLength(2)
    await h.dispose()
    h.events.close()
  })

  test("显式 steer 成功后给目标会话写委派标记", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_child",
          parentID: "ses_root",
          agent: "worker",
          model: FLASH_MODEL,
          outcome: "succeeded",
          time: { created: 1 },
        },
      ]),
      entries: { ses_root: rootEntries() },
    })
    await h.hooks["tool:execute.before"](call("steer1", { sessionID: "ses_child", model: "minimax/MiniMax-M2" }))
    // steer 的成功结果可以没有 result；目标会话由 input.sessionID 提供。
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "steer1", status: "completed" })
    const update = h.updates.find((item) => item.sessionID === "ses_child")
    expect(update?.metadata?.[MODEL_DELEGATION_METADATA_KEY]).toMatchObject({
      model: { providerID: "minimax", id: "MiniMax-M2" },
      source: MODEL_DELEGATION_MARKER_SOURCE,
    })
    await h.dispose()
    h.events.close()
  })

  test("session.created 在工具完成前写入委派标记，默认同步可立即看到", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_child",
          parentID: "ses_root",
          agent: "worker",
          model: { providerID: "kimi", id: "k3.1-pro" },
          metadata: {},
          time: { created: 1 },
        },
      ]),
      entries: { ses_root: rootEntries() },
    })
    await h.hooks["tool:execute.before"](call("c1", { model: "kimi/k3.1-pro" }))
    // 父会话、标题、模型任一不匹配的创建事件都不能误标。
    for (const mismatched of [
      { parentID: "ses_root", title: "other task", model: { providerID: "kimi", id: "k3.1-pro" } },
      { parentID: "ses_other", title: "task", model: { providerID: "kimi", id: "k3.1-pro" } },
      { parentID: "ses_root", title: "task", model: { providerID: "kimi", id: "k3.1-pro", variant: "high" } },
    ]) {
      h.events.push({
        type: "session.created",
        data: {
          sessionID: "ses_child",
          agent: "worker",
          metadata: {},
          ...mismatched,
        },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.updates).toHaveLength(0)
    // 父会话、标题与模型都匹配：工具还在执行时就写标记。
    h.events.push({
      type: "session.created",
      data: {
        sessionID: "ses_child",
        parentID: "ses_root",
        title: "task",
        agent: "worker",
        model: { providerID: "kimi", id: "k3.1-pro" },
        metadata: {},
      },
    })
    await waitFor(() => h.updates.some((item) => item.sessionID === "ses_child"))
    const early = h.updates.find((item) => item.sessionID === "ses_child")
    expect(early?.metadata?.[MODEL_DELEGATION_METADATA_KEY]).toMatchObject({
      model: { providerID: "kimi", id: "k3.1-pro" },
      source: MODEL_DELEGATION_MARKER_SOURCE,
    })
    expect(
      hookLog().some((record) => record.event === "model-delegation-marked" && record.phase === "created"),
    ).toBe(true)
    expect(
      hookLog().some((record) => record.event === "model-delegation-marked" && record.phase === "completed"),
    ).toBe(false)
    // execute.after 成功后补写同一标记，创建阶段的标记已覆盖完整默认同步窗口。
    await h.hooks["tool:execute.after"]({
      tool: "subagent",
      id: "c1",
      status: "completed",
      result: { metadata: { sessionID: "ses_child", status: "completed" } },
    })
    expect(
      h.updates.some(
        (item) =>
          item.sessionID === "ses_child" &&
          (item.metadata?.[MODEL_DELEGATION_METADATA_KEY] as Record<string, unknown>)?.source ===
            MODEL_DELEGATION_MARKER_SOURCE,
      ),
    ).toBe(true)
    expect(
      hookLog().some((record) => record.event === "model-delegation-marked" && record.phase === "completed"),
    ).toBe(true)
    await h.dispose()
    h.events.close()
  })

  test("委派标记不是旗舰，不占旗舰上限", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_delegated",
          parentID: "ses_root",
          agent: "worker",
          model: ROOT_MODEL,
          metadata: delegatedMarker(ROOT_MODEL),
          outcome: "succeeded",
          time: { created: 10 },
        },
      ]),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 1 }]) },
    })
    await h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" }))
    expect(h.removed).toEqual([])
    const allowed = hookLog().find((record) => record.event === "subagent-allowed")
    expect(allowed?.flagship).toBe(true)
    expect(allowed?.flagshipExist).toBe(0)
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c1" })
    await h.dispose()
    h.events.close()
  })
})

describe("槽位归还与淘汰保护", () => {
  test("allow 后在途回落；拒绝不泄漏槽位", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions(),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 1 }]) },
    })
    await h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" }))
    expect(String((await denied(h.hooks["tool:execute.before"](call("c2", { model: "acme/flagship#high" })))).message)).toContain(
      "旗舰子代理上限已满",
    )
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c1" })
    // 拒绝没有泄漏槽位：释放 c1 后第三个可以放行。
    await h.hooks["tool:execute.before"](call("c3", { model: "acme/flagship#high" }))
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c3" })
    await h.dispose()
    h.events.close()
  })

  test("lookup 异常 fail-open 且归还已占的槽", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions(),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 1 }]) },
      failSecondEntryList: true,
    })
    // 第一次：collab 读成功，readLimit 抛错 → lookup-failed，放行且还槽。
    await h.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" }))
    expect(hookLog().some((record) => record.event === "lookup-failed")).toBe(true)
    // 第二次：如果第一次泄漏了旗舰槽，这里会被拒绝。
    await h.hooks["tool:execute.before"](call("c2", { model: "acme/flagship#high" }))
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "c2" })
    await h.dispose()
    h.events.close()
  })

  test("保护名单与运行中的旗舰不能被淘汰", async () => {
    tempState()
    const kept = await setup({
      sessions: baseSessions([finishedFlagship("ses_kept", 1)]),
      entries: {
        ses_root: rootEntries([
          { key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 1 },
          { key: "superagent.kept-subagents", value: "ses_kept" },
        ]),
      },
    })
    expect(String((await denied(kept.hooks["tool:execute.before"](call("k1", { model: "acme/flagship#high" })))).message)).toContain(
      "旗舰子代理上限已满",
    )
    expect(kept.removed).toEqual([])
    await kept.dispose()
    kept.events.close()

    const running = await setup({
      sessions: baseSessions([runningFlagship("ses_run")]),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 1 }]) },
    })
    expect(String((await denied(running.hooks["tool:execute.before"](call("r1", { model: "acme/flagship#high" })))).message)).toContain(
      "旗舰子代理上限已满",
    )
    expect(running.removed).toEqual([])
    await running.dispose()
    running.events.close()
  })

  test("listChildren 保留 model 与 metadata，仅带来源且当前模型一致的标记计入旗舰", async () => {
    tempState()
    const stale = await setup({
      sessions: baseSessions([
        {
          id: "ses_marked",
          parentID: "ses_root",
          model: FLASH_MODEL,
          metadata: structuredClone(flagshipMarker),
          outcome: "succeeded",
          time: { created: 1 },
        },
        {
          id: "ses_plain",
          parentID: "ses_root",
          model: FLASH_MODEL,
          outcome: "succeeded",
          time: { created: 2 },
        },
      ]),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 1 }]) },
    })
    // child 已经切到 Flash：marker 过期，不占旗舰名额，也无需淘汰。
    await stale.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" }))
    expect(stale.removed).toEqual([])
    await stale.dispose()
    stale.events.close()

    const marked = await setup({
      sessions: baseSessions([
        {
          id: "ses_marked",
          parentID: "ses_root",
          model: ROOT_MODEL,
          metadata: structuredClone(flagshipMarker),
          outcome: "succeeded",
          time: { created: 1 },
        },
      ]),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 1 }]) },
    })
    // child 当前模型与 marker 一致：1 个已有 + 本次 1 个 > 1，且已完成可淘汰。
    await marked.hooks["tool:execute.before"](call("c2", { model: "acme/flagship#high" }))
    expect(marked.removed).toEqual(["ses_marked"])
    await marked.hooks["tool:execute.after"]({ tool: "subagent", id: "c2" })
    await marked.dispose()
    marked.events.close()
  })

  test("无来源的旧自动标记不计数：limit=0 拒绝时也不删、F2 场景不触发旗舰淘汰", async () => {
    tempState()
    const legacyChildren = () => [
      {
        id: "ses_l1",
        parentID: "ses_root",
        agent: "worker",
        model: ROOT_MODEL,
        metadata: structuredClone(legacyAutoMarker),
        outcome: "succeeded",
        time: { created: 10 },
      },
      {
        id: "ses_l2",
        parentID: "ses_root",
        agent: "worker",
        model: ROOT_MODEL,
        metadata: structuredClone(legacyAutoMarker),
        outcome: "succeeded",
        time: { created: 20 },
      },
    ]
    // limit=0：显式旗舰被拒（quota 本身为 0），旧自动标记的 child 不被删。
    const zero = await setup({
      sessions: baseSessions(legacyChildren()),
      entries: { ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 0 }]) },
    })
    expect(String((await denied(zero.hooks["tool:execute.before"](call("c1", { model: "acme/flagship#high" })))).message)).toContain(
      "旗舰子代理上限已满",
    )
    expect(zero.removed).toEqual([])
    const deniedRow = hookLog().find((record) => record.event === "subagent-denied")
    expect(deniedRow.flagshipExist).toBe(0)
    await zero.dispose()
    zero.events.close()

    // F2 场景（root 已切到旗舰、旧 child 模型恰同款）：显式旗舰不因旧标记占满，照常放行且不删。
    const f2 = await setup({
      sessions: baseSessions(legacyChildren()),
      entries: { ses_root: rootEntries() },
    })
    await f2.hooks["tool:execute.before"](call("c2", { model: "acme/flagship#high" }))
    expect(f2.removed).toEqual([])
    const allowedRow = hookLog().find((record) => record.event === "subagent-allowed")
    expect(allowedRow.flagshipExist).toBe(0)
    await f2.hooks["tool:execute.after"]({ tool: "subagent", id: "c2" })
    await f2.dispose()
    f2.events.close()
  })
})
describe("淘汰并发竞态", () => {
  const normalChild = (id: string, created: number, running = false): FakeSession => ({
    id,
    parentID: "ses_root",
    agent: "worker",
    model: FLASH_MODEL,
    outcome: running ? null : "succeeded",
    time: running ? { created, busy: created } : { created },
  })

  test("两个并发 new 选中同一 victim：后到者 NotFound 后刷新继续，不误拒", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        normalChild("ses_run1", NOW - 5000, true),
        normalChild("ses_run2", NOW - 4000, true),
        normalChild("ses_run3", NOW - 3000, true),
        normalChild("ses_fin1", NOW - 2000),
        normalChild("ses_fin2", NOW - 1000),
      ]),
      entries: { ses_root: rootEntries() },
      barrier: true,
    })

    const results = await Promise.allSettled([
      h.hooks["tool:execute.before"](call("race1")),
      h.hooks["tool:execute.before"](call("race2")),
    ])

    expect(results.every((result) => result.status === "fulfilled")).toBe(true)
    // 两个已结束的各删一次；后到者的 NotFound 不应把 victim 再记一次。
    expect([...h.removed].sort()).toEqual(["ses_fin1", "ses_fin2"])
    expect(new Set(h.removed).size).toBe(h.removed.length)
    const rows = hookLog()
    expect(rows.filter((row) => row.event === "subagent-denied" && row.reason === "total-limit")).toHaveLength(0)
    const concurrent = rows.filter((row) => row.event === "evict-concurrent")
    expect(concurrent.length).toBeGreaterThanOrEqual(1)
    expect(["race1", "race2"]).toContain(concurrent[0].callID)
    expect(concurrent[0].root).toBe("ses_root")
    expect(concurrent[0].victim).toMatch(/^ses_fin[12]$/)
    // 两个调用都放行时看到的最终口径：3 个运行中 + 2 个在途 = 5。
    const allowed = rows.filter((row) => row.event === "subagent-allowed")
    expect(allowed).toHaveLength(2)
    for (const row of allowed) {
      expect(row.exist).toBe(3)
      expect(row.inflight).toBe(2)
      expect(row.exist + row.inflight).toBe(5)
    }
    expect([...h.sessions.values()].filter((session) => session.parentID === "ses_root")).toHaveLength(3)

    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "race1" })
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "race2" })
    await h.dispose()
    h.events.close()
  })

  test("remove 真失败且刷新后 victim 仍在：仍拒绝，且只尝试一次不死循环", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        normalChild("ses_run1", NOW - 5000, true),
        normalChild("ses_run2", NOW - 4000, true),
        normalChild("ses_run3", NOW - 3000, true),
        normalChild("ses_fin1", NOW - 2000),
        normalChild("ses_fin2", NOW - 1000),
      ]),
      entries: { ses_root: rootEntries() },
      failRemove: true,
    })

    const error = await denied(h.hooks["tool:execute.before"](call("fail1")))
    expect(String(error.message)).toContain("Subagent 存在上限已满")
    expect(h.removed).toEqual([])
    const rows = hookLog()
    expect(rows.filter((row) => row.event === "evict-failed")).toHaveLength(1)
    expect(rows.some((row) => row.event === "evict-concurrent")).toBe(false)
    expect(rows.filter((row) => row.event === "subagent-denied" && row.reason === "total-limit")).toHaveLength(1)
    // 会话一个都没少：刷新确认 victim 仍在后按真实失败处理。
    expect([...h.sessions.values()].filter((session) => session.parentID === "ses_root")).toHaveLength(5)

    await h.dispose()
    h.events.close()
  })

  test("两个并发 steer 切旗舰选中同一 victim：NotFound 刷新后继续，不误拒 steer", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        {
          id: "ses_child1",
          parentID: "ses_root",
          agent: "worker",
          model: FLASH_MODEL,
          outcome: "succeeded",
          time: { created: NOW - 4000 },
        },
        {
          id: "ses_child2",
          parentID: "ses_root",
          agent: "worker",
          model: FLASH_MODEL,
          outcome: "succeeded",
          time: { created: NOW - 3000 },
        },
        finishedFlagship("ses_f1", NOW - 2000),
        finishedFlagship("ses_f2", NOW - 1000),
      ]),
      entries: {
        ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 2 }]),
      },
      barrier: true,
    })

    const results = await Promise.allSettled([
      h.hooks["tool:execute.before"](
        call("steer1", { sessionID: "ses_child1", model: "acme/flagship#high" }),
      ),
      h.hooks["tool:execute.before"](
        call("steer2", { sessionID: "ses_child2", model: "acme/flagship#high" }),
      ),
    ])

    expect(results.every((result) => result.status === "fulfilled")).toBe(true)
    expect([...h.removed].sort()).toEqual(["ses_f1", "ses_f2"])
    const rows = hookLog()
    expect(rows.filter((row) => row.event === "subagent-denied")).toHaveLength(0)
    const concurrent = rows.filter((row) => row.event === "evict-concurrent" && row.reason === "steer-switch")
    expect(concurrent.length).toBeGreaterThanOrEqual(1)
    expect(["steer1", "steer2"]).toContain(concurrent[0].callID)
    expect(concurrent[0].root).toBe("ses_root")

    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "steer1" })
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "steer2" })
    await h.dispose()
    h.events.close()
  })

  test("remove 失败且刷新列表也失败：记录刷新原因后拒绝，不假装成功", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([
        normalChild("ses_run1", NOW - 5000, true),
        normalChild("ses_run2", NOW - 4000, true),
        normalChild("ses_run3", NOW - 3000, true),
        normalChild("ses_fin1", NOW - 2000),
        normalChild("ses_fin2", NOW - 1000),
      ]),
      entries: { ses_root: rootEntries() },
      failRemove: true,
    })
    const originalList = h.ctx.session.list
    let listCalls = 0
    h.ctx.session.list = async (...args: any[]) => {
      listCalls++
      if (listCalls === 2) throw new Error("list down")
      return originalList(...args)
    }

    const error = await denied(h.hooks["tool:execute.before"](call("fail2")))
    expect(String(error.message)).toContain("Subagent 存在上限已满")
    const rows = hookLog()
    const failed = rows.filter((row) => row.event === "evict-failed")
    expect(failed).toHaveLength(1)
    expect(String(failed[0].refreshCause)).toContain("list down")
    expect(rows.some((row) => row.event === "evict-concurrent")).toBe(false)
    expect(h.removed).toEqual([])

    await h.dispose()
    h.events.close()
  })

  test("两个并发旗舰 new 选中同一 victim：NotFound 刷新后继续，不误判旗舰超限", async () => {
    tempState()
    const h = await setup({
      sessions: baseSessions([finishedFlagship("ses_f1", NOW - 2000), finishedFlagship("ses_f2", NOW - 1000)]),
      entries: {
        ses_root: rootEntries([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 2 }]),
      },
      barrier: true,
    })

    const results = await Promise.allSettled([
      h.hooks["tool:execute.before"](call("flag1", { model: "acme/flagship#high" })),
      h.hooks["tool:execute.before"](call("flag2", { model: "acme/flagship#high" })),
    ])

    expect(results.every((result) => result.status === "fulfilled")).toBe(true)
    expect([...h.removed].sort()).toEqual(["ses_f1", "ses_f2"])
    const rows = hookLog()
    expect(rows.filter((row) => row.event === "subagent-denied")).toHaveLength(0)
    const concurrent = rows.filter((row) => row.event === "evict-concurrent" && row.reason === "flagship-limit")
    expect(concurrent.length).toBeGreaterThanOrEqual(1)
    expect(concurrent[0].root).toBe("ses_root")
    expect(["flag1", "flag2"]).toContain(concurrent[0].callID)
    expect([...h.sessions.values()].filter((session) => session.parentID === "ses_root")).toHaveLength(0)

    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "flag1" })
    await h.hooks["tool:execute.after"]({ tool: "subagent", id: "flag2" })
    await h.dispose()
    h.events.close()
  })
})
