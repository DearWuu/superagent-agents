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
  const sentPrompts: Array<{ sessionID: string; text: string }> = []
  const switched: Array<{ sessionID: string; model: { providerID: string; id: string; variant?: string } }> = []
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
          switched.push(input)
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
        interrupt: async () => {},
        remove: async ({ sessionID }: { sessionID: string }) => {
          order.push("remove")
          removedSessions.push(sessionID)
          const index = sessions.findIndex((item) => item.id === sessionID)
          if (index >= 0) sessions.splice(index, 1)
          byId.delete(sessionID)
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
        outcome: "succeeded",
        time: { created: 2, updated: 200 },
      },
      {
        id: "f2",
        parentID: "root",
        title: "新旗舰",
        agent: "executor",
        model: rootModel,
        outcome: "succeeded",
        time: { created: 3, updated: 300 },
      },
      {
        id: "f3",
        parentID: "root",
        title: "运行中旗舰",
        agent: "executor",
        model: rootModel,
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

test("a protected subagent keeps its model when the default changes", async () => {
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
    expect(h.switched.length).toBe(0)
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