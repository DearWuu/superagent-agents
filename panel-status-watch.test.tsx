/** @jsxImportSource @opentui/solid */
/**
 * 面板的子代理状态监测开关：设置项展示、写入指令条目、停用状态回显。
 */
import { expect, test, mock } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore, produce } from "solid-js/store"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (value: unknown) => value } }))
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
  outcome?: "succeeded" | "failed" | "interrupted"
  time?: { created: number; updated: number; archived?: number; busy?: number; idle?: number }
}

const rootModel = { providerID: "p", id: "root" }
const models = [{ ...rootModel, name: "Root Model" }]

function harness(options?: {
  instructions?: Record<string, unknown>
  selections?: unknown[]
}) {
  const sessions: Session[] = [
    { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
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
        policies: {},
        defaultPolicy: "inherit",
        defaultModel: undefined,
        defaultSetAt: undefined,
        maxSubagents: 5,
        expanded: {},
        initialized: { root: true },
        keptSubagents: {},
        assignmentPrompt: "",
        oversight: { pins: { models: {}, sessions: {} }, capabilityOverrides: {}, history: {}, lastResolved: {} },
      },
    },
  })
  const puts: Array<{ sessionID: string; key: string; value: unknown }> = []
  const removes: string[] = []
  const toasts: string[] = []
  const dialogs: any[] = []
  const selections = options?.selections ?? []
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
        family: () => ["root"],
        status: () => "idle",
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
        switchModel: async () => {},
        compact: async () => {},
        create: async (input: any) => ({ id: "created", ...input }),
        prompt: async () => {},
        interrupt: async () => {},
        remove: async () => {},
      },
    },
    keymap: { layer: () => {} },
    ui: {
      model: { current: () => undefined, select: undefined },
      dialog: {
        alert: async () => {},
        clear: () => {},
        confirm: async () => true,
        prompt: async () => undefined,
        select: async (input: any) => {
          dialogs.push(input)
          return selections.shift()
        },
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
  return { context, entryState, settings, puts, removes, toasts, dialogs }
}

async function render(options?: Parameters<typeof harness>[0]) {
  const h = harness(options)
  const preferencePath = path.join(mkdtempSync(path.join(tmpdir(), "status-watch-")), "model.json")
  const app = await testRender(
    () => (
      <SidebarAgents
        context={h.context as never}
        sessionID="root"
        preferencePath={preferencePath}
        criticDir={path.join(tmpdir(), "status-watch-critic-empty")}
      />
    ),
    { width: 100, height: 28 },
  )
  app.renderer.start()
  return { app, ...h }
}

test("设置里有「子代理状态监测」，默认显示已启用", async () => {
  const h = await render()
  try {
    const settings = h.app.renderer.root.findDescendantById("sidebar.agents.settings")!
    await h.app.mockMouse.click(settings.x, settings.y)
    await h.app.flush()
    await h.app.waitFor(() => h.dialogs.length > 0)
    const options = h.dialogs[0].options as Array<{ title: string; description: string }>
    const item = options.find((option) => option.title === "子代理状态监测")
    expect(item).toBeDefined()
    expect(item?.description).toBe("已启用")
  } finally {
    h.app.renderer.destroy()
  }
})

test("停用后设置项显示已停用", async () => {
  const h = await render({ instructions: { "superagent.status-watch": "false" } })
  try {
    const settings = h.app.renderer.root.findDescendantById("sidebar.agents.settings")!
    await h.app.mockMouse.click(settings.x, settings.y)
    await h.app.flush()
    await h.app.waitFor(() => h.dialogs.length > 0)
    const options = h.dialogs[0].options as Array<{ title: string; description: string }>
    const item = options.find((option) => option.title === "子代理状态监测")
    expect(item?.description).toBe("已停用")
  } finally {
    h.app.renderer.destroy()
  }
})

test("选择停用会写入 superagent.status-watch 条目", async () => {
  const h = await render({ selections: [{ kind: "statusWatch" }, { kind: "off" }] })
  try {
    const settings = h.app.renderer.root.findDescendantById("sidebar.agents.settings")!
    await h.app.mockMouse.click(settings.x, settings.y)
    await h.app.flush()
    await h.app.waitFor(() => h.puts.some((item) => item.key === "superagent.status-watch"))
    expect(h.puts.filter((item) => item.key === "superagent.status-watch").at(-1)).toEqual({
      sessionID: "root",
      key: "superagent.status-watch",
      value: "false",
    })
    expect(h.toasts.at(-1)).toBe("已停用子代理状态监测。")
  } finally {
    h.app.renderer.destroy()
  }
})

test("选择启用会写入 true", async () => {
  const h = await render({
    instructions: { "superagent.status-watch": "false" },
    selections: [{ kind: "statusWatch" }, { kind: "on" }],
  })
  try {
    const settings = h.app.renderer.root.findDescendantById("sidebar.agents.settings")!
    await h.app.mockMouse.click(settings.x, settings.y)
    await h.app.flush()
    await h.app.waitFor(() => h.puts.some((item) => item.key === "superagent.status-watch"))
    expect(h.puts.filter((item) => item.key === "superagent.status-watch").at(-1)?.value).toBe("true")
    expect(h.toasts.at(-1)).toBe("已启用子代理状态监测。")
  } finally {
    h.app.renderer.destroy()
  }
})
