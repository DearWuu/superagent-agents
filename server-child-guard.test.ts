/**
 * 子代理拦截与计数/并发：F2 提问与嵌套派发拒绝（真实 setup + 假 ctx）、
 * F1 默认模型接线（a–g）、A1 在途派生与实体化、A2 抛错归还与超期回收、
 * A3 readLimit 上溯、A4 metadata 串行读-改-写。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import plugin, {
  PENDING_DISPATCH_REAP_MS,
  countInflight,
  executeSubagentWithInterrupt,
  pickMaterializedCall,
  reapPendingDispatches,
} from "./server"
import { readLimit, updateSessionMetadata } from "./server-session"

type FakeSession = {
  id: string
  parentID?: string
  title?: string
  model?: unknown
  metadata?: Record<string, unknown>
  time?: { created?: number; busy?: number; idle?: number }
}

type HarnessOptions = {
  sessions: FakeSession[]
  entries?: Record<string, Array<{ key: string; value: unknown }>>
  models?: Array<{ providerID: string; id: string }>
  entryListThrows?: boolean
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
  for (const session of options.sessions) sessions.set(session.id, { ...session })

  const nativeInputs: any[] = []
  const hooks: Record<string, any> = {}
  const events = eventQueue()
  const tool = {
    id: "subagent",
    name: "subagent",
    input: { type: "object", properties: { prompt: { type: "string" } } },
    execute: async (input: any) => {
      nativeInputs.push(input)
      return { output: "done", metadata: { sessionID: "ses_child", status: "completed" } }
    },
  }
  const toolEditor = {
    get: (id: string) => (id === "subagent" ? tool : undefined),
    update: (_id: string, update: (value: any) => void) => update(tool),
  }

  const ctx = {
    tool: {
      hook: async (name: string, handler: any) => {
        hooks[`tool:${name}`] = handler
        return { dispose() {} }
      },
      transform: async (callback: any) => {
        callback(toolEditor)
        return { dispose() {} }
      },
    },
    event: { subscribe: () => events.iterable },
    model: {
      list: async () => ({ data: options.models ?? [] }),
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
      async create(input: any) {
        const id = "ses_critic"
        sessions.set(id, { id, parentID: input.parentID, title: input.title, metadata: input.metadata, time: { busy: 1, idle: 2 } })
        return sessions.get(id)
      },
      async update(input: { sessionID: string; metadata?: Record<string, unknown> }) {
        const found = sessions.get(input.sessionID)
        if (found) found.metadata = input.metadata
      },
      async prompt() {
        return { id: "msg" }
      },
      async context() {
        return []
      },
      async synthetic() {
        return { id: "msg_syn" }
      },
      async remove({ sessionID }: { sessionID: string }) {
        sessions.delete(sessionID)
      },
      async switchModel() {},
      async interrupt() {},
      instructions: {
        entry: {
          async list({ sessionID }: { sessionID: string }) {
            if (options.entryListThrows) throw new Error("entry list boom")
            return options.entries?.[sessionID] ?? []
          },
          async put() {},
          async remove() {},
        },
      },
    },
  }

  return { ctx, tool, hooks, nativeInputs, sessions, events }
}

const cleanups: string[] = []

function tempState() {
  const dir = mkdtempSync(path.join(tmpdir(), "superagent-guard-"))
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

const ROOT = "ses_root"
const CHILD = "ses_child"

function guarded(overrides: Partial<HarnessOptions> = {}) {
  return harness({
    sessions: [
      { id: ROOT, title: "root" },
      { id: CHILD, parentID: ROOT, title: "子任务" },
    ],
    ...overrides,
  })
}

async function withSetup<T>(h: ReturnType<typeof harness>, run: (dispose: () => Promise<void>) => Promise<T>) {
  const dispose = await (plugin as any).setup(h.ctx)
  try {
    return await run(dispose)
  } finally {
    await dispose()
    h.events.close()
  }
}

describe("F2 子代理拦截（真实 setup + 假 ctx）", () => {
  test("(h) 子会话提问被拒且文案正确，root 提问放行", async () => {
    tempState()
    const h = guarded()
    await withSetup(h, async () => {
      await expect(
        h.hooks["tool:execute.before"]({ tool: "question", sessionID: CHILD, id: "call-q", input: {} }),
      ).rejects.toThrow("子代理不得向用户提问")
      await expect(
        h.hooks["tool:execute.before"]({ tool: "question", sessionID: ROOT, id: "call-q2", input: {} }),
      ).resolves.toBeUndefined()
    })
  })

  test("(i) 子会话嵌套派发在任何派工前被拒并记 nested-dispatch-denied", async () => {
    tempState()
    const h = guarded()
    await withSetup(h, async () => {
      await expect(
        h.hooks["tool:execute.before"]({
          tool: "subagent",
          sessionID: CHILD,
          id: "call-n",
          input: { agent: "worker", description: "偷派", prompt: "go" },
        }),
      ).rejects.toThrow("子代理不得再派发子代理")
      expect(
        await waitFor(() =>
          readJsonl(process.env.SUPERAGENT_HOOK_LOG!).some(
            (record) => record.event === "nested-dispatch-denied" && record.sessionID === CHILD,
          ),
        ),
      ).toBe(true)
    })
  })

  test("(j) 协作停用时提问与嵌套派发都不拦", async () => {
    tempState()
    const h = guarded({ entries: { [ROOT]: [{ key: "superagent.collab-enabled", value: false }] } })
    await withSetup(h, async () => {
      await expect(
        h.hooks["tool:execute.before"]({ tool: "question", sessionID: CHILD, id: "call-q", input: {} }),
      ).resolves.toBeUndefined()
      await expect(
        h.hooks["tool:execute.before"]({
          tool: "subagent",
          sessionID: CHILD,
          id: "call-n",
          input: { agent: "worker", description: "偷派", prompt: "go" },
        }),
      ).resolves.toBeUndefined()
    })
  })
})

describe("F1 默认模型接线（真实 setup，注入只进交宿主的输入）", () => {
  const FIXED = [
    { key: "superagent.default-policy", value: "fixed" },
    { key: "superagent.default-model", value: "openai/gpt-5" },
  ]
  const MODELS = [{ providerID: "openai", id: "gpt-5" }]
  const ctxOf = (id: string) => ({ id, sessionID: ROOT, signal: new AbortController().signal })
  /** 回执与在途计数都来自 execute.before 登记的台账：先走一遍 before 再执行。 */
  async function dispatch(h: ReturnType<typeof harness>, input: any, callID: string) {
    await h.hooks["tool:execute.before"]({ tool: "subagent", sessionID: ROOT, id: callID, input })
    return h.tool.execute(input, ctxOf(callID))
  }

  test("(a) fixed 默认，新建不带 model → 宿主收到默认模型", async () => {
    tempState()
    const h = guarded({ entries: { [ROOT]: FIXED }, models: MODELS })
    await withSetup(h, async () => {
      const result = await dispatch(h, { agent: "worker", description: "任务", prompt: "go" }, "call-a")
      expect(h.nativeInputs[0]).toMatchObject({ prompt: "go", model: "openai/gpt-5" })
      expect(result.output).toContain("（默认策略）")
    })
  })

  test("(b) 显式 model → 输入不变，不触发默认解析", async () => {
    tempState()
    const h = guarded({ entries: { [ROOT]: FIXED }, models: MODELS })
    await withSetup(h, async () => {
      await dispatch(h, { agent: "worker", prompt: "go", model: "zhipuai/glm" }, "call-b")
      expect(h.nativeInputs[0].model).toBe("zhipuai/glm")
      expect(h.nativeInputs[0].model).not.toContain("默认策略")
      expect(
        readJsonl(process.env.SUPERAGENT_HOOK_LOG!).some((record) => record.event === "dispatch-model-resolved"),
      ).toBe(false)
    })
  })

  test("(c) 续跑旧模型的子会话 → 注入默认模型", async () => {
    tempState()
    const h = guarded({ entries: { [ROOT]: FIXED }, models: MODELS })
    h.sessions.get(CHILD)!.model = "other/old"
    await withSetup(h, async () => {
      await dispatch(h, { sessionID: CHILD, prompt: "继续" }, "call-c")
      expect(h.nativeInputs[0]).toMatchObject({ sessionID: CHILD, model: "openai/gpt-5" })
    })
  })

  test("(d) 续跑带有效委派标记的子会话 → 不注入", async () => {
    tempState()
    const h = guarded({ entries: { [ROOT]: FIXED }, models: MODELS })
    h.sessions.get(CHILD)!.model = "other/old"
    h.sessions.get(CHILD)!.metadata = {
      "superagent.model-delegation": { model: "other/old", at: 1, source: "explicit-subagent-model" },
    }
    await withSetup(h, async () => {
      await dispatch(h, { sessionID: CHILD, prompt: "继续" }, "call-d")
      expect(h.nativeInputs[0].model).toBeUndefined()
    })
  })

  test("(e) 每子代理策略 auto / fixed 不注入，inherit 注入 root 模型", async () => {
    tempState()
    const h = guarded({
      entries: { [ROOT]: FIXED },
      models: [...MODELS, { providerID: "base", id: "root" }],
    })
    h.sessions.get(ROOT)!.model = "base/root"
    h.sessions.get(CHILD)!.model = "other/old"
    await withSetup(h, async () => {
      for (const policy of ["auto", "fixed"] as const) {
        h.sessions.get(CHILD)!.metadata = { "superagent.model-policy": policy }
        h.nativeInputs.length = 0
        await dispatch(h, { sessionID: CHILD, prompt: "继续" }, `call-e-${policy}`)
        expect(h.nativeInputs[0].model).toBeUndefined()
      }
      h.sessions.get(CHILD)!.metadata = { "superagent.model-policy": "inherit" }
      h.nativeInputs.length = 0
      await dispatch(h, { sessionID: CHILD, prompt: "继续" }, "call-e-inherit")
      expect(h.nativeInputs[0].model).toBe("base/root")
    })
  })

  test("(f) 默认模型不在可用列表 → 不注入、回执带 warning、日志有事件", async () => {
    tempState()
    const h = guarded({ entries: { [ROOT]: FIXED }, models: [] })
    await withSetup(h, async () => {
      const result = await dispatch(h, { agent: "worker", prompt: "go" }, "call-f")
      expect(h.nativeInputs[0].model).toBeUndefined()
      expect(result.output).toContain("未能确认可用")
      expect(
        readJsonl(process.env.SUPERAGENT_HOOK_LOG!).some(
          (record) => record.event === "dispatch-default-model-unavailable",
        ),
      ).toBe(true)
    })
  })

  test("(g) 解析抛错 → 照常派工", async () => {
    tempState()
    const h = guarded({ entries: { [ROOT]: FIXED }, models: MODELS, entryListThrows: true })
    await withSetup(h, async () => {
      const result = await dispatch(h, { agent: "worker", prompt: "go" }, "call-g")
      expect(h.nativeInputs).toHaveLength(1)
      expect(h.nativeInputs[0].model).toBeUndefined()
      expect(result.output).toContain("done")
    })
  })
})

describe("A1 在途派生与实体化", () => {
  test("只数同 root 且未实体化的条目", () => {
    const entries = [
      { rootID: ROOT },
      { rootID: ROOT, materialized: true },
      { rootID: "ses_other" },
      {},
    ]
    expect(countInflight(entries, ROOT)).toBe(1)
  })

  test("新建子会话标记一条：critic 跳过、标题唯一匹配优先、否则最早一条", () => {
    const pending: Array<[string, any]> = [
      ["c0", { callerSessionID: ROOT, delegatedTitle: "A" }],
      ["c1", { callerSessionID: ROOT, delegatedTitle: "B" }],
      ["c2", { callerSessionID: "ses_other", delegatedTitle: "B" }],
    ]
    expect(pickMaterializedCall(pending, ROOT, "B", undefined)).toBe("c1")
    expect(pickMaterializedCall(pending, ROOT, "未知标题", undefined)).toBe("c0")
    expect(pickMaterializedCall(pending, ROOT, "B", { "superagent.critic": true })).toBeUndefined()
    expect(pickMaterializedCall([["s", { callerSessionID: ROOT, steerTarget: CHILD }]], ROOT, "A", undefined)).toBeUndefined()
  })

  test("已实体化或别的父会话的条目不再被选中", () => {
    const pending: Array<[string, any]> = [
      ["c0", { callerSessionID: ROOT, materialized: true }],
      ["c1", { callerSessionID: "ses_other" }],
    ]
    expect(pickMaterializedCall(pending, ROOT, "B", undefined)).toBeUndefined()
  })
})

describe("A2 抛错归还与超期回收", () => {
  test("原生 execute 抛错：onFailed 归还一次后重抛", async () => {
    const failed: Array<string | undefined> = []
    const run = () =>
      executeSubagentWithInterrupt(
        {} as any,
        async () => {
          throw new Error("native boom")
        },
        { agent: "worker", prompt: "go" },
        { id: "call-x", sessionID: ROOT, signal: new AbortController().signal },
        undefined,
        undefined,
        undefined,
        (callID) => failed.push(callID),
      )
    await expect(run()).rejects.toThrow("native boom")
    expect(failed).toEqual(["call-x"])
  })

  test("超期回收：归还计数与 steer hold、删除条目并记日志；未超期不动", () => {
    const now = 1_800_000_000_000
    const pending = new Map<string, any>([
      ["old", { rootID: ROOT, createdAt: now - PENDING_DISPATCH_REAP_MS - 1, flagshipRoot: ROOT, steerHeld: true }],
      ["fresh", { rootID: ROOT, createdAt: now }],
    ])
    const released: string[] = []
    const logs: any[] = []
    expect(
      reapPendingDispatches(pending, now, {
        releaseSteerHold: (entry) => released.push(entry.rootID),
        bumpFlagship: () => {},
        log: (record) => logs.push(record),
      }),
    ).toEqual(["old"])
    expect(pending.has("old")).toBe(false)
    expect(pending.has("fresh")).toBe(true)
    expect(logs[0]?.event).toBe("dispatch-pending-reaped")
    // 再回收一次为空：after 到来不会重复扣减。
    expect(
      reapPendingDispatches(pending, now + PENDING_DISPATCH_REAP_MS + 2, {
        releaseSteerHold: () => {},
        bumpFlagship: () => {},
        log: () => {},
      }),
    ).toEqual(["fresh"])
    expect(released).toHaveLength(1)
  })
})

describe("A3 readLimit 只认 max-subagents 条目并继续上溯", () => {
  function limitCtx(sessions: Record<string, any>, entries: Record<string, any[]>) {
    return {
      session: {
        async get({ sessionID }: { sessionID: string }) {
          const found = sessions[sessionID]
          if (!found) throw new Error("no session")
          return found
        },
        instructions: {
          entry: {
            async list({ sessionID }: { sessionID: string }) {
              return entries[sessionID] ?? []
            },
          },
        },
      },
    }
  }

  test("子会话只有 oversight-level 时上溯到 root 的 max-subagents", async () => {
    const ctx = limitCtx(
      { ses_root: { id: "ses_root" }, ses_child: { id: "ses_child", parentID: "ses_root" } },
      {
        ses_child: [{ key: "superagent.oversight-level", value: 3 }],
        ses_root: [{ key: "superagent.max-subagents", value: 8 }],
      },
    )
    expect(await readLimit(ctx, "ses_child", "ses_root")).toEqual({
      limit: 8,
      source: "ses_root",
      entries: [{ key: "superagent.max-subagents", value: 8 }],
    })
  })

  test("root 也没有相关条目：回退缺省 5 且 source 指 root", async () => {
    const ctx = limitCtx({ ses_root: { id: "ses_root" } }, { ses_root: [] })
    const found = await readLimit(ctx, "ses_root", "ses_root")
    expect(found.limit).toBe(5)
    expect(found.source).toBe("ses_root")
  })
})

describe("A4 metadata 串行读-改-写", () => {
  test("同一会话两个并发写入都保留", async () => {
    const store: { metadata: Record<string, unknown> } = { metadata: {} }
    const ctx = {
      session: {
        async get() {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return { metadata: { ...store.metadata } }
        },
        async update({ metadata }: { metadata: Record<string, unknown> }) {
          await new Promise((resolve) => setTimeout(resolve, 5))
          store.metadata = metadata
        },
      },
    }
    await Promise.all([
      updateSessionMetadata(ctx, "ses_a4", (current) => ({ ...(current ?? {}), a: 1 })),
      updateSessionMetadata(ctx, "ses_a4", (current) => ({ ...(current ?? {}), b: 2 })),
    ])
    expect(store.metadata).toEqual({ a: 1, b: 2 })
  })

  test("mutate 返回 undefined 时不写，链上的后续写入照常执行", async () => {
    const store: { metadata: Record<string, unknown> } = { metadata: { keep: true } }
    let updates = 0
    const ctx = {
      session: {
        async get() {
          return { metadata: { ...store.metadata } }
        },
        async update({ metadata }: { metadata: Record<string, unknown> }) {
          updates += 1
          store.metadata = metadata
        },
      },
    }
    expect(await updateSessionMetadata(ctx, "ses_a4b", () => undefined)).toBe(false)
    expect(await updateSessionMetadata(ctx, "ses_a4b", (current) => ({ ...(current ?? {}), c: 3 }))).toBe(true)
    expect(updates).toBe(1)
    expect(store.metadata).toEqual({ keep: true, c: 3 })
  })
})