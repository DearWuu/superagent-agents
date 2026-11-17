/** @jsxImportSource @opentui/solid */
import { expect, test, mock } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore, produce } from "solid-js/store"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (value: unknown) => value } }))
const order: string[] = []
const { SidebarAgents } = await import("./index")

const color = (value: number) => RGBA.fromInts(value, value, value)

function theme() {
  const tokens = {
    text: {
      base: color(255),
      muted: color(128),
      formfield: { focused: color(240), selected: color(200) },
      action: { primary: { focused: color(10) } },
      feedback: { warning: { base: color(255) } },
    },
    background: {
      action: { primary: { focused: color(250) } },
      formfield: { focused: color(40) },
    },
    hue: { accent: { 200: color(157) } },
    surface: () => tokens,
  }
  return tokens as never
}

type Session = {
  id: string
  parentID?: string
  title?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  metadata?: Record<string, unknown>
  outcome?: "succeeded" | "failed" | "interrupted"
  time?: { created: number; updated: number; archived?: number; busy?: number; idle?: number }
}

const rootModel = { providerID: "p", id: "root" }
const flash = { providerID: "p", id: "flash" }
const models = [
  { ...rootModel, name: "Root Model" },
  { ...flash, name: "Flash" },
]

function harness(options?: {
  sessions?: Session[]
  instructions?: Record<string, unknown>
  pins?: Record<string, number>
  policies?: Record<string, "auto" | "inherit" | "fixed">
  maxSubagents?: number
  maxFlagshipSubagents?: number
  defaultPolicy?: "auto" | "inherit" | "fixed"
  defaultModel?: { providerID: string; id: string; variant?: string }
  defaultSetAt?: number
  keptSubagents?: Record<string, boolean>
  initialized?: Record<string, boolean>
  selections?: unknown[]
  prompts?: string[]
  switchFails?: string[]
}) {
  const sessions: Session[] =
    options?.sessions ??
    [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      {
        id: "worker",
        parentID: "root",
        title: "实现接口",
        agent: "executor",
        model: rootModel,
        time: { created: 2, updated: 400 },
      },
    ]
  const byId = new Map(sessions.map((item) => [item.id, item]))
  const rootOf = (sessionID: string) => {
    let current = byId.get(sessionID)
    const seen = new Set<string>()
    while (current?.parentID && !seen.has(current.id)) {
      seen.add(current.id)
      current = byId.get(current.parentID)
    }
    return current?.id ?? sessionID
  }
  const family = (id: string) => sessions.filter((item) => rootOf(item.id) === id).map((item) => item.id)
  const entryState: Record<string, Record<string, unknown>> = {
    root: {
      "superagent.collab-enabled": "true",
      ...(options?.instructions ?? {}),
    },
  }
  const [settings, updateSettings] = createStore<any>({
    version: 2,
    autoModels: [],
    roots: {
      root: {
        policies: options?.policies ?? {},
        defaultPolicy: options?.defaultPolicy ?? "inherit",
        defaultModel: options?.defaultModel,
        defaultSetAt: options?.defaultSetAt,
        maxSubagents: options?.maxSubagents ?? 5,
        expanded: {},
        initialized: options?.initialized ?? { root: true },
        keptSubagents: options?.keptSubagents ?? {},
        assignmentPrompt: "",
        oversight: {
          pins: { models: {}, sessions: options?.pins ?? {} },
          capabilityOverrides: {},
          history: {},
          lastResolved: {},
        },
      },
    },
  })
  const puts: Array<{ sessionID: string; key: string; value: unknown }> = []
  const removes: string[] = []
  const removedSessions: string[] = []
  const createdSessions: any[] = []
  const sentPrompts: Array<{ sessionID: string; text: string; delivery?: string }> = []
  const switched: Array<{ sessionID: string; model: { providerID: string; id: string; variant?: string } }> = []
  const interrupts: string[] = []
  const syntheticCalls: any[] = []
  const switchFails = new Set(options?.switchFails ?? [])
  const selections = options?.selections ?? []
  const prompts = options?.prompts ?? []
  const toasts: string[] = []
  const confirms: Array<{ title: string; message: string }> = []
  const context = {
    theme: theme(),
    storage: {
      store: () => [
        settings,
        async (mutation: (draft: any) => void) => {
          updateSettings(produce(mutation))
        },
      ],
    },
    data: {
      session: {
        root: rootOf,
        get: (id: string) => byId.get(id),
        list: () => sessions,
        family,
        status: (id: string) => (byId.get(id)?.time?.busy ? "running" : "idle"),
        message: { list: () => [] },
      },
      location: { model: { list: () => models }, provider: { list: () => [] } },
    },
    client: {
      experimental: {
        session: {
          instructions: {
            entry: {
              list: async ({ sessionID }: { sessionID: string }) =>
                Object.entries(entryState[sessionID] ?? {}).map(([key, value]) => ({ key, value })),
              put: async ({ sessionID, key, value }: { sessionID: string; key: string; value: unknown }) => {
                puts.push({ sessionID, key, value })
                entryState[sessionID] = { ...(entryState[sessionID] ?? {}), [key]: value }
              },
              remove: async ({ sessionID, key }: { sessionID: string; key: string }) => {
                removes.push(`${sessionID}:${key}`)
                if (entryState[sessionID]) delete entryState[sessionID][key]
              },
            },
          },
        },
      },
      session: {
        switchModel: async (input: { sessionID: string; model: any }) => {
          if (switchFails.has(input.sessionID)) throw new Error("switch failed")
          switched.push(input)
          // 真实宿主切换后会更新会话模型，并由原生 model.selected 清掉旗舰标记。
          const session = byId.get(input.sessionID)
          if (session) {
            session.model = input.model
            if (session.metadata) delete session.metadata["superagent.flagship"]
          }
        },
        compact: async () => {},
        create: async (input: any) => {
          const created = { id: `created-${input?.title ?? "child"}`, ...input }
          createdSessions.push(created)
          return created
        },
        prompt: async (input: { sessionID: string; text: string }) => {
          sentPrompts.push(input)
        },
        interrupt: async ({ sessionID }: { sessionID: string }) => {
          interrupts.push(sessionID)
          // 直切流程不应调用 interrupt；这里只为断言「调用次数为 0」留记录。
          const session = byId.get(sessionID)
          if (session?.time) delete session.time.busy
        },
        remove: async ({ sessionID }: { sessionID: string }) => {
          order.push("remove")
          removedSessions.push(sessionID)
          const index = sessions.findIndex((item) => item.id === sessionID)
          if (index >= 0) sessions.splice(index, 1)
          byId.delete(sessionID)
        },
        /** 面板手动操作回传：真实宿主有这条 API，假客户端也要跟上。 */
        synthetic: async (input: any) => {
          syntheticCalls.push(input)
          return { id: "syn_1" }
        },
      },
    },
    keymap: { layer: () => {} },
    ui: {
      model: { current: () => undefined, select: undefined },
      dialog: {
        alert: async () => {},
        clear: () => {},
        confirm: async (input: { title: string; message: string }) => {
          confirms.push(input)
          return true
        },
        prompt: async () => prompts.shift(),
        select: async () => selections.shift(),
        show: () => {},
      },
      router: { navigate: () => {} },
      toast: {
        show: ({ message }: { message: string }) => {
          toasts.push(message)
        },
      },
    },
  }
  return {
    context,
    entryState,
    settings,
    puts,
    removes,
    removedSessions,
    createdSessions,
    sentPrompts,
    switched,
    interrupts,
    syntheticCalls,
    toasts,
    confirms,
  }
}

async function render(options?: Parameters<typeof harness>[0]) {
  const h = harness(options)
  const preferencePath = path.join(mkdtempSync(path.join(tmpdir(), "flagship-ui-")), "model.json")
  const app = await testRender(
    () => (
      <SidebarAgents
        context={h.context as never}
        sessionID="root"
        preferencePath={preferencePath}
        criticDir={path.join(tmpdir(), "flagship-critic-empty")}
      />
    ),
    { width: 100, height: 28 },
  )
  app.renderer.start()
  return { app, ...h }
}

test("settings keep the flagship default while the panel stays silent", async () => {
  const h = await render({ selections: [{ kind: "maxFlagshipSubagents" }], prompts: ["7"] })
  try {
    const settings = h.app.renderer.root.findDescendantById("sidebar.agents.settings")!
    await h.app.mockMouse.click(settings.x, settings.y)
    await h.app.flush()
    await h.app.waitFor(() => h.puts.some((item) => item.key === "superagent.max-flagship-subagents"))
    expect(h.puts.filter((item) => item.key === "superagent.max-flagship-subagents").at(-1)).toEqual({
      sessionID: "root",
      key: "superagent.max-flagship-subagents",
      value: 7,
    })
    expect(h.app.captureCharFrame()).not.toContain("旗舰")
  } finally {
    h.app.renderer.destroy()
  }
})

test("a metadata marker does not surface flagship branding in the panel", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      {
        id: "old",
        parentID: "root",
        title: "旧同款",
        agent: "executor",
        model: flash,
        metadata: { "superagent.flagship": true },
        time: { created: 2, updated: 400 },
      },
      {
        id: "ordinary",
        parentID: "root",
        title: "普通",
        agent: "executor",
        model: flash,
        time: { created: 3, updated: 300 },
      },
    ],
    policies: { ordinary: "fixed" },
  })
  try {
    await h.app.flush()
    await h.app.waitFor(() => h.app.captureCharFrame().includes("子代理"))
    expect(h.app.captureCharFrame()).not.toContain("旗舰")
  } finally {
    h.app.renderer.destroy()
  }
})

test("root default updates unpinned child entries and leaves a pinned child alone", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      {
        id: "pinned",
        parentID: "root",
        title: "固定子代理",
        agent: "executor",
        model: flash,
        time: { created: 2, updated: 400 },
      },
      {
        id: "free",
        parentID: "root",
        title: "默认子代理",
        agent: "executor",
        model: flash,
        time: { created: 3, updated: 300 },
      },
    ],
    pins: { pinned: 1 },
    selections: [{ kind: "pin", level: 3 }],
  })
  try {
    await h.app.flush()
    await h.app.waitFor(() => h.entryState.free?.["superagent.oversight-level"] === 2)
    expect(h.entryState.pinned?.["superagent.oversight-level"]).toBe(1)
    const oversight = h.app.renderer.root.findDescendantById("sidebar.agents.oversight")!
    await h.app.mockMouse.click(oversight.x, oversight.y)
    await h.app.waitFor(() => h.entryState.free?.["superagent.oversight-level"] === 3)
    expect(h.entryState.pinned?.["superagent.oversight-level"]).toBe(1)
    expect(String(h.entryState.free?.["superagent.assignment-prompt"])).toContain("L3 · 全量级")
  } finally {
    h.app.renderer.destroy()
  }
})

test("the flagship cap evicts only the oldest finished flagship", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      {
        id: "f1",
        parentID: "root",
        title: "旧旗舰",
        agent: "executor",
        model: rootModel,
        metadata: { "superagent.flagship": { model: rootModel, at: 1, source: "explicit-subagent-delegation" } },
        outcome: "succeeded",
        time: { created: 2, updated: 200 },
      },
      {
        id: "f2",
        parentID: "root",
        title: "新旗舰",
        agent: "executor",
        model: rootModel,
        metadata: { "superagent.flagship": { model: rootModel, at: 1, source: "explicit-subagent-delegation" } },
        outcome: "succeeded",
        time: { created: 3, updated: 300 },
      },
      {
        id: "f3",
        parentID: "root",
        title: "运行中旗舰",
        agent: "executor",
        model: rootModel,
        metadata: { "superagent.flagship": { model: rootModel, at: 1, source: "explicit-subagent-delegation" } },
        time: { created: 4, updated: 400, busy: 400 },
      },
      {
        id: "plain",
        parentID: "root",
        title: "普通",
        agent: "executor",
        model: flash,
        outcome: "succeeded",
        time: { created: 1, updated: 100 },
      },
    ],
    instructions: { "superagent.max-flagship-subagents": 2 },
    maxSubagents: 10,
    policies: { plain: "fixed" },
  })
  try {
    await h.app.flush()
    await h.app.waitFor(() => !h.context.data.session.get("f1"))
    expect(h.context.data.session.get("f1")).toBeUndefined()
    expect(h.context.data.session.get("f2")).toBeDefined()
    expect(h.context.data.session.get("f3")).toBeDefined()
    expect(h.context.data.session.get("plain")).toBeDefined()
  } finally {
    h.app.renderer.destroy()
  }
})

test("unmarked same-model subagents are never evicted by the flagship cap", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      {
        id: "u1",
        parentID: "root",
        title: "同款一",
        agent: "executor",
        model: rootModel,
        outcome: "succeeded",
        time: { created: 2, updated: 200 },
      },
      {
        id: "u2",
        parentID: "root",
        title: "同款二",
        agent: "executor",
        model: rootModel,
        outcome: "succeeded",
        time: { created: 3, updated: 300 },
      },
      {
        id: "u3",
        parentID: "root",
        title: "同款三",
        agent: "executor",
        model: rootModel,
        outcome: "succeeded",
        time: { created: 4, updated: 400 },
      },
    ],
    instructions: { "superagent.max-flagship-subagents": 1 },
    maxSubagents: 10,
  })
  try {
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(h.context.data.session.get("u1")).toBeDefined()
    expect(h.context.data.session.get("u2")).toBeDefined()
    expect(h.context.data.session.get("u3")).toBeDefined()
  } finally {
    h.app.renderer.destroy()
  }
})

test("deleting a subagent removes the session and creates nothing", async () => {
  order.length = 0
  const h = await render({ selections: [{ kind: "delete" }] })
  try {
    await h.app.waitForFrame((frame) => frame.includes("实现接口"))
    const title = h.app.renderer.root.findDescendantById("sidebar.agents.title.worker")!
    await h.app.mockMouse.click(title.x, title.y)
    await h.app.flush()
    await h.app.waitFor(() => h.removedSessions.includes("worker"))
    expect(order).toEqual(["remove"])
    expect(h.createdSessions.length).toBe(0)
    expect(h.sentPrompts.length).toBe(0)
    expect(h.toasts.at(-1)).toContain("已删除")
    expect(h.confirms.at(-1)).toMatchObject({ title: "删除 Subagent" })
    expect(String((h.confirms.at(-1) as { message: string }).message)).toContain("子会话")
  } finally {
    h.app.renderer.destroy()
  }
})

test("a protected subagent can still be deleted by hand", async () => {
  order.length = 0
  const h = await render({ selections: [{ kind: "delete" }], keptSubagents: { worker: true } })
  try {
    await h.app.waitForFrame((frame) => frame.includes("实现接口"))
    const title = h.app.renderer.root.findDescendantById("sidebar.agents.title.worker")!
    await h.app.mockMouse.click(title.x, title.y)
    await h.app.flush()
    await h.app.waitFor(() => h.removedSessions.includes("worker"))
    expect(order).toEqual(["remove"])
    expect(h.createdSessions.length).toBe(0)
    expect(h.sentPrompts.length).toBe(0)
    expect(h.toasts.at(-1)).toContain("已删除")
  } finally {
    h.app.renderer.destroy()
  }
})

test("a protected subagent still follows the default model; protection only blocks eviction", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      {
        id: "worker",
        parentID: "root",
        title: "实现接口",
        agent: "executor",
        model: flash,
        time: { created: 2, updated: 400 },
      },
    ],
    defaultPolicy: "fixed",
    defaultModel: { providerID: "p", id: "root" },
    defaultSetAt: 1,
    keptSubagents: { worker: true },
  })
  try {
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.switched.map((item) => item.sessionID)).toEqual(["worker"])
    expect(h.switched[0]!.model).toMatchObject({ providerID: "p", id: "root" })
  } finally {
    h.app.renderer.destroy()
  }
})

test("a fixed default switch preserves the variant", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      {
        id: "new",
        parentID: "root",
        title: "新子代理",
        agent: "executor",
        model: flash,
        time: { created: 5, updated: 500 },
      },
    ],
    defaultPolicy: "fixed",
    defaultModel: { providerID: "p", id: "flash", variant: "high" },
    defaultSetAt: 2,
  })
  try {
    await h.app.flush()
    await h.app.waitFor(() => h.switched.length > 0)
    expect(h.switched[0]!.model).toEqual({ providerID: "p", id: "flash", variant: "high" })
  } finally {
    h.app.renderer.destroy()
  }
})
// —— 用户调小旗舰上限：现有超额旗舰切到子代理默认模型，不删会话 ——

const flagshipMeta = (model = rootModel) => ({
  "superagent.flagship": { model, at: 1, source: "explicit-subagent-delegation" },
})

function flagshipSession(id: string, created: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    parentID: "root",
    title: id,
    agent: "executor",
    model: rootModel,
    metadata: flagshipMeta(),
    time: { created, updated: created },
    ...extra,
  }
}

async function settle(h: any, predicate: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await h.app.flush()
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("settle timeout")
}

async function openSettings(h: any) {
  const settings = h.app.renderer.root.findDescendantById("sidebar.agents.settings")!
  await h.app.mockMouse.click(settings.x, settings.y)
  await h.app.flush()
}

test("lowering the flagship cap switches the oldest overflow to the fixed default", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      flagshipSession("f1", 2),
      flagshipSession("f2", 3),
      flagshipSession("f3", 4),
    ],
    instructions: { "superagent.max-flagship-subagents": 3 },
    maxSubagents: 10,
    defaultPolicy: "fixed",
    defaultModel: flash,
    selections: [{ kind: "maxFlagshipSubagents" }],
    prompts: ["1"],
  })
  try {
    await h.app.flush()
    await openSettings(h)
    await settle(h, () => h.switched.length === 2)
    expect(h.switched.map((item: any) => item.sessionID)).toEqual(["f1", "f2"])
    expect(h.switched.every((item: any) => item.model.id === "flash")).toBe(true)
    expect(h.removedSessions).toEqual([])
    expect(h.context.data.session.get("f1")).toBeDefined()
    expect(h.puts.at(-1)).toEqual({
      sessionID: "root",
      key: "superagent.max-flagship-subagents",
      value: 1,
    })
    expect(h.toasts.at(-1)).toContain("已把 2 个超额旗舰切到 Flash")
    await settle(h, () => h.syntheticCalls.length === 1)
    expect(h.syntheticCalls[0]).toMatchObject({ sessionID: "root", delivery: "queue" })
    expect(h.syntheticCalls[0].metadata.action).toBe("max-flagship")
    expect(h.syntheticCalls[0].text).toContain("已切换 2 个")
    expect(h.syntheticCalls[0].text).toContain("跳过 0 个")
  } finally {
    h.app.renderer.destroy()
  }
})

test("inherit resolves the target from the current root model", async () => {
  // 两个子代理各自被显式固定到 Flash 并留下旗舰 marker；root 默认策略是跟随会话，
  // 所以目标就是 root 当前模型。
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      flagshipSession("f1", 2, { model: flash, metadata: flagshipMeta(flash) }),
      flagshipSession("f2", 3, { model: flash, metadata: flagshipMeta(flash) }),
    ],
    instructions: { "superagent.max-flagship-subagents": 2 },
    maxSubagents: 10,
    policies: { f1: "fixed", f2: "fixed" },
    defaultPolicy: "inherit",
    selections: [{ kind: "maxFlagshipSubagents" }],
    prompts: ["1"],
  })
  try {
    await h.app.flush()
    await openSettings(h)
    await settle(h, () => h.switched.length === 1)
    expect(h.switched[0]).toMatchObject({ sessionID: "f1", model: { providerID: "p", id: "root" } })
  } finally {
    h.app.renderer.destroy()
  }
})

test("a running overflow flagship switches directly without interrupt or steer", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      flagshipSession("f1", 2, {
        time: { created: 2, updated: 2, busy: 2 },
      }),
    ],
    instructions: { "superagent.max-flagship-subagents": 2 },
    maxSubagents: 10,
    defaultPolicy: "fixed",
    defaultModel: flash,
    selections: [{ kind: "maxFlagshipSubagents" }],
    prompts: ["0"],
  })
  try {
    await h.app.flush()
    const putsBefore = h.puts.length
    await openSettings(h)
    await settle(h, () => h.switched.length === 1)
    expect(h.interrupts).toEqual([])
    expect(h.sentPrompts).toEqual([])
    expect(h.puts.slice(putsBefore).filter((item: any) => item.sessionID === "f1")).toEqual([])
  } finally {
    h.app.renderer.destroy()
  }
})

test("kept flagships are switched too; kept only shields them from eviction", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      flagshipSession("kept", 2),
      flagshipSession("f2", 3),
    ],
    instructions: { "superagent.max-flagship-subagents": 2 },
    maxSubagents: 10,
    keptSubagents: { kept: true },
    defaultPolicy: "fixed",
    defaultModel: flash,
    selections: [{ kind: "maxFlagshipSubagents" }],
    prompts: ["1"],
  })
  try {
    await h.app.flush()
    await openSettings(h)
    await settle(h, () => h.switched.length === 1)
    expect(h.switched[0]!.sessionID).toBe("kept")
    expect(h.removedSessions).toEqual([])
  } finally {
    h.app.renderer.destroy()
  }
})

test("auto has no unique target: overflow flagships are not switched and the toast says so", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      flagshipSession("f1", 2),
      flagshipSession("f2", 3),
    ],
    instructions: { "superagent.max-flagship-subagents": 2 },
    maxSubagents: 10,
    defaultPolicy: "auto",
    selections: [{ kind: "maxFlagshipSubagents" }],
    prompts: ["1"],
  })
  try {
    await h.app.flush()
    await openSettings(h)
    await settle(h, () => h.puts.some((item: any) => item.key === "superagent.max-flagship-subagents" && item.value === 1))
    expect(h.switched).toEqual([])
    const summary = h.toasts.find((message: string) => message.includes("未自动切换"))
    expect(summary).toContain("自动")
    await settle(h, () => h.syntheticCalls.length === 1)
    expect(h.syntheticCalls[0].text).toContain("跳过 1 个")
  } finally {
    h.app.renderer.destroy()
  }
})

test("a flagship already on the target is skipped, not faked as switched", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      flagshipSession("f1", 2),
      flagshipSession("f2", 3),
    ],
    instructions: { "superagent.max-flagship-subagents": 2 },
    maxSubagents: 10,
    defaultPolicy: "fixed",
    defaultModel: rootModel,
    selections: [{ kind: "maxFlagshipSubagents" }],
    prompts: ["1"],
  })
  try {
    await h.app.flush()
    await openSettings(h)
    await settle(h, () => h.toasts.some((message: string) => message.includes("跳过 1 个")))
    expect(h.switched).toEqual([])
    expect(h.toasts.some((message: string) => message.includes("已是目标模型"))).toBe(true)
  } finally {
    h.app.renderer.destroy()
  }
})

test("one failed switch does not stop the rest; failures are counted", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      flagshipSession("f1", 2),
      flagshipSession("f2", 3),
      flagshipSession("f3", 4),
    ],
    instructions: { "superagent.max-flagship-subagents": 3 },
    maxSubagents: 10,
    defaultPolicy: "fixed",
    defaultModel: flash,
    switchFails: ["f1"],
    selections: [{ kind: "maxFlagshipSubagents" }],
    prompts: ["1"],
  })
  try {
    await h.app.flush()
    await openSettings(h)
    await settle(h, () => h.switched.length === 1)
    expect(h.switched[0]!.sessionID).toBe("f2")
    expect(
      h.toasts.some((message: string) => message.includes("已把 1 个超额旗舰") && message.includes("跳过 1 个")),
    ).toBe(true)
    expect(h.puts.at(-1)).toMatchObject({ key: "superagent.max-flagship-subagents", value: 1 })
  } finally {
    h.app.renderer.destroy()
  }
})

test("mounting an over-limit panel never converges existing flagships", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      flagshipSession("f1", 2),
      flagshipSession("f2", 3),
    ],
    instructions: { "superagent.max-flagship-subagents": 1 },
    maxSubagents: 10,
    defaultPolicy: "fixed",
    defaultModel: flash,
  })
  try {
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(h.switched).toEqual([])
    expect(h.interrupts).toEqual([])
  } finally {
    h.app.renderer.destroy()
  }
})

test("archived children, grandchildren and legacy markers never enter the switch plan", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      flagshipSession("f1", 2),
      flagshipSession("f2", 3),
      flagshipSession("arch", 4, { time: { created: 4, updated: 4, archived: 1 } }),
      flagshipSession("grand", 5, { parentID: "f1" }),
      flagshipSession("legacy", 6, { metadata: { "superagent.flagship": true } }),
    ],
    instructions: { "superagent.max-flagship-subagents": 2 },
    maxSubagents: 10,
    defaultPolicy: "fixed",
    defaultModel: flash,
    selections: [{ kind: "maxFlagshipSubagents" }],
    prompts: ["1"],
  })
  try {
    await h.app.flush()
    await openSettings(h)
    await settle(h, () => h.switched.length === 1)
    expect(h.switched.map((item: any) => item.sessionID)).toEqual(["f1"])
    expect(h.removedSessions).toEqual([])
  } finally {
    h.app.renderer.destroy()
  }
})

function lastPut(h: any, sessionID: string, key: string) {
  return h.puts.filter((item: any) => item.sessionID === sessionID && item.key === key).at(-1)
}

test("root 分配提示只带报告协议，Superagent 条目只带验收动作", async () => {
  const h = await render()
  try {
    await settle(
      h,
      () =>
        Boolean(lastPut(h, "root", "superagent.oversight")) &&
        Boolean(lastPut(h, "root", "superagent.assignment-prompt")) &&
        Boolean(lastPut(h, "worker", "superagent.assignment-prompt")),
    )
    const rootAssignment = String(lastPut(h, "root", "superagent.assignment-prompt")!.value)
    const rootOversight = String(lastPut(h, "root", "superagent.oversight")!.value)
    const childAssignment = String(lastPut(h, "worker", "superagent.assignment-prompt")!.value)
    expect(rootAssignment).toContain("[报告协议 L2")
    expect(rootAssignment).not.toContain("[Superagent 验收动作")
    expect(rootOversight).toContain("[Superagent 验收动作")
    expect(rootOversight).not.toContain("[报告协议")
    expect(childAssignment).toContain("[报告协议 L2")
    expect(childAssignment).not.toContain("[Superagent 验收动作")
    expect(childAssignment).toContain("按任务书执行，不扩大范围")
    // 子代理条目同时保留机器可读的监管等级。
    expect(String(lastPut(h, "worker", "superagent.oversight-level")!.value)).toBe("2")
  } finally {
    h.app.renderer.destroy()
  }
})

test("报告风格切换实时更新 root 与未 pin 子代理的分配提示", async () => {
  const h = await render({
    instructions: { "superagent.report-style": "concise" },
    selections: [{ kind: "policy" }, { kind: "report" }, "detailed"],
  })
  try {
    await settle(h, () => String(lastPut(h, "root", "superagent.assignment-prompt")?.value).includes("简洁"))
    await openSettings(h)
    await settle(
      h,
      () =>
        String(lastPut(h, "root", "superagent.assignment-prompt")?.value).includes("详细") &&
        String(lastPut(h, "worker", "superagent.assignment-prompt")?.value).includes("详细"),
    )
    const rootAssignment = String(lastPut(h, "root", "superagent.assignment-prompt")!.value)
    const childAssignment = String(lastPut(h, "worker", "superagent.assignment-prompt")!.value)
    expect(rootAssignment).toContain("[报告协议 L2 · 证据级 · 详细]")
    expect(childAssignment).toContain("[报告协议 L2 · 证据级 · 详细]")
    // 报告风格只影响报告协议，不把验收动作混进分配提示。
    expect(rootAssignment).not.toContain("[Superagent 验收动作")
    // root 的验收条目也不因为风格变化重复报告格式。
    expect(String(lastPut(h, "root", "superagent.oversight")!.value)).not.toContain("[报告协议")
  } finally {
    h.app.renderer.destroy()
  }
})

test("手动操作通知不受状态监测开关影响，设置项写明用户与生效值", async () => {
  const h = await render({
    instructions: { "superagent.status-watch": "false", "superagent.report-style": "concise" },
    selections: [{ kind: "policy" }, { kind: "report" }, "detailed"],
  })
  try {
    await h.app.flush()
    await openSettings(h)
    await settle(h, () => h.syntheticCalls.length >= 1)
    expect(h.syntheticCalls).toHaveLength(1)
    const call = h.syntheticCalls[0]
    expect(call.sessionID).toBe("root")
    expect(call.delivery).toBe("queue")
    expect(call.metadata).toMatchObject({
      source: "superagent-agents",
      kind: "manual-op",
      action: "setting",
    })
    expect(String(call.text)).toContain("用户")
    expect(String(call.text)).toContain("这不是你的指令")
    expect(String(call.text)).toContain("报告风格")
    expect(String(call.text)).toContain("详细")
  } finally {
    h.app.renderer.destroy()
  }
})

test("一轮设置操作合并成一条 queue 通知", async () => {
  const h = await render({
    selections: [{ kind: "policy" }, { kind: "report" }, "detailed", { kind: "prompt" }],
    prompts: ["只改右栏"],
  })
  try {
    await h.app.flush()
    await openSettings(h)
    await settle(h, () => h.syntheticCalls.length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(h.syntheticCalls).toHaveLength(1)
    const call = h.syntheticCalls[0]
    expect(call.metadata.action).toBe("batch")
    expect(call.metadata.actions).toEqual(["setting", "setting"])
    expect(String(call.text)).toContain("报告风格")
    expect(String(call.text)).toContain("会话补充提示词")
    expect(call.delivery).toBe("queue")
  } finally {
    h.app.renderer.destroy()
  }
})
