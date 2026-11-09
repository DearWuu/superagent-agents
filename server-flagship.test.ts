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