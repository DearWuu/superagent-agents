/** @jsxImportSource @opentui/solid */
import { expect, test, mock } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore, produce } from "solid-js/store"
import { createSignal } from "solid-js"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (value: unknown) => value } }))
const { SidebarAgents } = await import("./index")
const { sameModel } = await import("./model-policy")

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
const nextModel = { providerID: "p", id: "root-next" }
const kimiHigh = { providerID: "kimi", id: "k3.1-pro", variant: "high" }
const kimi = { providerID: "kimi", id: "k3.1-pro" }
const qoder = { providerID: "qoder", id: "qwen3-8-flash" }
const qoderNext = { providerID: "qoder", id: "qwen3-8-max" }
/** Server 为显式 `input.model` 调用写入的委派标记。 */
const delegated = (model: { providerID: string; id: string; variant?: string }) => ({
  "superagent.model-delegation": { model, at: 1, source: "explicit-subagent-model" },
})
const models = [
  { ...rootModel, name: "Root Model" },
  { ...flash, name: "Flash" },
  { ...nextModel, name: "Root Next" },
]

function harness(options?: {
  sessions?: Session[]
  instructions?: Record<string, unknown>
  policies?: Record<string, "auto" | "inherit" | "fixed">
  maxSubagents?: number
  defaultPolicy?: "auto" | "inherit" | "fixed"
  defaultModel?: { providerID: string; id: string; variant?: string }
  defaultSetAt?: number
  keptSubagents?: Record<string, boolean>
  selections?: unknown[]
  failSwitchFor?: string
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
        model: flash,
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
        initialized: { root: true },
        keptSubagents: options?.keptSubagents ?? {},
        assignmentPrompt: "",
        oversight: { pins: { models: {}, sessions: {} }, capabilityOverrides: {}, history: {}, lastResolved: {} },
      },
    },
  })
  const puts: Array<{ sessionID: string; key: string; value: unknown }> = []
  const removes: string[] = []
  const removedSessions: string[] = []
  const createdSessions: any[] = []
  const sentPrompts: Array<{ sessionID: string; text: string; delivery?: string }> = []
  const switched: Array<{ sessionID: string; model: { providerID: string; id: string; variant?: string } }> = []
  const calls: string[] = []
  const selections = options?.selections ?? []
  const toasts: string[] = []
  const confirms: Array<{ title: string; message: string }> = []
  // The host exposes the root model through `ui.model.current()`; changing it is
  // how the root session switches models at runtime.
  const [selected, setSelected] = createSignal<{ providerID: string; modelID: string; variant?: string }>()
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
          calls.push(`switch:${input.sessionID}`)
          if (options?.failSwitchFor === input.sessionID) throw new Error("模型不可用")
          switched.push(input)
        },
        compact: async () => {},
        create: async (input: any) => {
          createdSessions.push(input)
          return { id: "created", ...input }
        },
        prompt: async (input: { sessionID: string; text: string; delivery?: string }) => {
          calls.push(`prompt:${input.sessionID}`)
          sentPrompts.push(input)
        },
        interrupt: async ({ sessionID }: { sessionID: string }) => {
          calls.push(`interrupt:${sessionID}`)
          const item = byId.get(sessionID)
          if (item?.time) item.time.busy = undefined
        },
        remove: async ({ sessionID }: { sessionID: string }) => {
          calls.push(`remove:${sessionID}`)
          removedSessions.push(sessionID)
        },
      },
    },
    keymap: { layer: () => {} },
    ui: {
      model: {
        current: () => {
          const value = selected()
          return value ? { providerID: value.providerID, modelID: value.modelID, variant: value.variant } : undefined
        },
        select: undefined,
      },
      dialog: {
        alert: async () => {},
        clear: () => {},
        confirm: async (input: { title: string; message: string }) => {
          confirms.push(input)
          return true
        },
        prompt: async () => undefined,
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
  /** The root session switches its model at runtime. */
  const setRootModel = (model: { providerID: string; id: string; variant?: string }) =>
    setSelected({ providerID: model.providerID, modelID: model.id, variant: model.variant })
  /** The user changes the root-scoped default model. */
  const setDefaultModel = (model: { providerID: string; id: string; variant?: string }) =>
    updateSettings(
      produce((draft: any) => {
        draft.roots.root.defaultPolicy = "fixed"
        draft.roots.root.defaultModel = model
        draft.roots.root.defaultSetAt = Date.now()
      }),
    )
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
    calls,
    toasts,
    confirms,
    setRootModel,
    setDefaultModel,
  }
}

async function render(options?: Parameters<typeof harness>[0]) {
  const h = harness(options)
  const preferencePath = path.join(mkdtempSync(path.join(tmpdir(), "default-model-")), "model.json")
  const app = await testRender(
    () => (
      <SidebarAgents
        context={h.context as never}
        sessionID="root"
        preferencePath={preferencePath}
        criticDir={path.join(tmpdir(), "default-model-critic-empty")}
      />
    ),
    { width: 100, height: 28 },
  )
  app.renderer.start()
  return { app, ...h }
}

const threeChildren = [
  { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
  { id: "a", parentID: "root", title: "甲", agent: "executor", model: flash, time: { created: 2, updated: 400 } },
  { id: "b", parentID: "root", title: "乙", agent: "executor", model: flash, time: { created: 3, updated: 300 } },
]

test("sameModel 将缺省 variant 与字面 default 视为等价", () => {
  const withoutVariant = { providerID: "p", id: "root" }
  const defaultVariant = { ...withoutVariant, variant: "default" }
  expect(sameModel(withoutVariant, defaultVariant)).toBe(true)
  expect(sameModel(defaultVariant, withoutVariant)).toBe(true)
  expect(sameModel(defaultVariant, { ...withoutVariant, variant: "high" })).toBe(false)
})

test("首次挂载不批量改旧会话", async () => {
  const h = await render({ sessions: threeChildren, defaultPolicy: "inherit" })
  try {
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.switched.length).toBe(0)
  } finally {
    h.app.renderer.destroy()
  }
})

test("fixed 默认在首次挂载时不批量改旧会话", async () => {
  const h = await render({
    sessions: threeChildren,
    defaultPolicy: "fixed",
    defaultModel: rootModel,
    defaultSetAt: 1000,
  })
  try {
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.switched.length).toBe(0)
  } finally {
    h.app.renderer.destroy()
  }
})

test("inherit 在 root 后续变更时同步所有未保护子代理", async () => {
  const h = await render({ sessions: threeChildren, defaultPolicy: "inherit" })
  try {
    await h.app.flush()
    expect(h.switched.length).toBe(0)
    h.setRootModel(nextModel)
    await h.app.waitFor(() => h.switched.length >= 2)
    expect(h.switched.map((item) => item.sessionID).sort()).toEqual(["a", "b"])
    expect(h.switched[0]!.model).toEqual(nextModel)
  } finally {
    h.app.renderer.destroy()
  }
})

test("auto 子代理不被批量修改", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      { id: "auto", parentID: "root", title: "自动", agent: "executor", model: flash, time: { created: 2, updated: 400 } },
      { id: "free", parentID: "root", title: "普通", agent: "executor", model: flash, time: { created: 3, updated: 300 } },
    ],
    policies: { auto: "auto" },
    defaultPolicy: "inherit",
  })
  try {
    await h.app.flush()
    h.setRootModel(nextModel)
    await h.app.waitFor(() => h.switched.length >= 1)
    expect(h.switched.map((item) => item.sessionID)).toEqual(["free"])
  } finally {
    h.app.renderer.destroy()
  }
})

test("fixed 只在用户真正变更目标时批量修改", async () => {
  const h = await render({
    sessions: threeChildren,
    defaultPolicy: "fixed",
    defaultModel: flash,
    defaultSetAt: 1000,
  })
  try {
    await h.app.flush()
    expect(h.switched.length).toBe(0)
    h.setDefaultModel(nextModel)
    await h.app.waitFor(() => h.switched.length >= 2)
    expect(h.switched.map((item) => item.sessionID).sort()).toEqual(["a", "b"])
    // The same target again is not a user change: no second batch.
    h.setDefaultModel(nextModel)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.switched.length).toBe(2)
  } finally {
    h.app.renderer.destroy()
  }
})

test("批量切换保留 variant", async () => {
  const h = await render({
    sessions: threeChildren,
    defaultPolicy: "fixed",
    defaultModel: flash,
    defaultSetAt: 1000,
  })
  try {
    await h.app.flush()
    h.setDefaultModel({ providerID: "p", id: "root", variant: "high" })
    await h.app.waitFor(() => h.switched.length >= 2)
    expect(h.switched[0]!.model).toEqual({ providerID: "p", id: "root", variant: "high" })
  } finally {
    h.app.renderer.destroy()
  }
})

test("受保护子代理跳过默认同步", async () => {
  const h = await render({
    sessions: threeChildren,
    defaultPolicy: "fixed",
    defaultModel: flash,
    defaultSetAt: 1000,
    keptSubagents: { a: true },
  })
  try {
    await h.app.flush()
    h.setDefaultModel(nextModel)
    await h.app.waitFor(() => h.switched.length >= 1)
    expect(h.switched.map((item) => item.sessionID)).toEqual(["b"])
  } finally {
    h.app.renderer.destroy()
  }
})

test("默认同步到 root 同模型不受旗舰上限影响", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      {
        id: "flag",
        parentID: "root",
        title: "旗舰",
        agent: "executor",
        model: rootModel,
        metadata: { "superagent.flagship": { model: rootModel, at: 1, source: "explicit-subagent-delegation" } },
        time: { created: 2, updated: 400 },
      },
      { id: "a", parentID: "root", title: "甲", agent: "executor", model: flash, time: { created: 3, updated: 300 } },
      { id: "b", parentID: "root", title: "乙", agent: "executor", model: flash, time: { created: 4, updated: 200 } },
    ],
    instructions: { "superagent.max-flagship-subagents": 3 },
    defaultPolicy: "fixed",
    defaultModel: flash,
    defaultSetAt: 1000,
  })
  try {
    await h.app.flush()
    h.setDefaultModel(rootModel)
    await h.app.waitFor(() => h.switched.length >= 1)
    expect(h.toasts.some((message) => message.includes("超过上限"))).toBe(false)
    // The already flagship child stays on the same model; only the others switch.
    expect(h.switched.map((item) => item.sessionID).sort()).toEqual(["a", "b"])
  } finally {
    h.app.renderer.destroy()
  }
})

test("默认批量同步不因目标与 root 同模型被拒绝", async () => {
  const h = await render({
    sessions: threeChildren,
    instructions: { "superagent.max-flagship-subagents": 1 },
    maxSubagents: 5,
    policies: { a: "inherit", b: "inherit" },
    defaultPolicy: "fixed",
    defaultModel: flash,
    defaultSetAt: 1000,
  })
  try {
    await h.app.flush()
    h.setDefaultModel(rootModel)
    await h.app.waitFor(() => h.switched.length >= 2)
    // 默认批量同步不是显式旗舰委派：即使目标与 root 同模型也照常执行。
    expect(h.toasts.some((message) => message.includes("超过上限"))).toBe(false)
    expect(h.switched.map((item) => item.sessionID).sort()).toEqual(["a", "b"])
  } finally {
    h.app.renderer.destroy()
  }
})

test("默认同步跳过 default variant 等价的同模型子代理", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      {
        id: "worker",
        parentID: "root",
        title: "同模型",
        agent: "executor",
        model: { ...rootModel, variant: "default" },
        time: { created: 2, updated: 400, busy: 400 },
      },
    ],
    defaultPolicy: "fixed",
    defaultModel: flash,
    defaultSetAt: 1000,
  })
  try {
    await h.app.flush()
    h.setDefaultModel(rootModel)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.switched).toEqual([])
    expect(h.calls).not.toContain("interrupt:worker")
    expect(h.sentPrompts).toEqual([])
  } finally {
    h.app.renderer.destroy()
  }
})

test("显式 input.model 委派的子代理不被 fixed 默认覆盖", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: kimiHigh, time: { created: 1, updated: 500 } },
      {
        id: "delegated",
        parentID: "root",
        title: "显式委派",
        agent: "executor",
        model: kimi,
        metadata: delegated(kimi),
        time: { created: 2000, updated: 400 },
      },
    ],
    defaultPolicy: "fixed",
    defaultModel: qoder,
    defaultSetAt: 1000,
  })
  try {
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 100))
    // 新建子代理晚于 defaultSetAt，但显式模型标记优先：挂载不切。
    expect(h.switched).toEqual([])
    // 用户改目标后走批量同步，标记模型仍与当前模型一致：仍然不切。
    h.setDefaultModel(qoderNext)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.switched).toEqual([])
  } finally {
    h.app.renderer.destroy()
  }
})

test("无标记或标记模型已不匹配时 fixed 默认照常覆盖", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: kimiHigh, time: { created: 1, updated: 500 } },
      {
        id: "plain",
        parentID: "root",
        title: "无标记",
        agent: "executor",
        model: kimi,
        time: { created: 2000, updated: 400 },
      },
      {
        id: "stale",
        parentID: "root",
        title: "已切走",
        agent: "executor",
        model: kimi,
        metadata: delegated(kimiHigh),
        time: { created: 3000, updated: 300 },
      },
    ],
    defaultPolicy: "fixed",
    defaultModel: qoder,
    defaultSetAt: 1000,
  })
  try {
    await h.app.flush()
    await h.app.waitFor(() => h.switched.length >= 2)
    expect(h.switched.map((item) => item.sessionID).sort()).toEqual(["plain", "stale"])
    expect(h.switched.every((item) => item.model.providerID === "qoder")).toBe(true)
  } finally {
    h.app.renderer.destroy()
  }
})

test("子代理手动 fixed 策略优先于 root 默认模型", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: kimiHigh, time: { created: 1, updated: 500 } },
      {
        id: "manual",
        parentID: "root",
        title: "手动指定",
        agent: "executor",
        model: kimi,
        time: { created: 2000, updated: 400 },
      },
      {
        id: "plain",
        parentID: "root",
        title: "未指定",
        agent: "executor",
        model: kimi,
        time: { created: 3000, updated: 300 },
      },
    ],
    policies: { manual: "fixed" },
    defaultPolicy: "fixed",
    defaultModel: qoder,
    defaultSetAt: 1000,
  })
  try {
    await h.app.flush()
    await h.app.waitFor(() => h.switched.length >= 1)
    // 手动 fixed 是显式选择：挂载默认只覆盖未指定策略的普通子代理。
    expect(h.switched.map((item) => item.sessionID)).toEqual(["plain"])
    expect(h.switched[0]!.model).toEqual(qoder)
    h.setDefaultModel(qoderNext)
    await h.app.waitFor(() => h.switched.length >= 2)
    expect(h.switched.map((item) => item.sessionID)).toEqual(["plain", "plain"])
    expect(h.switched.at(-1)!.model).toEqual(qoderNext)
    expect(h.switched.some((item) => item.sessionID === "manual")).toBe(false)
  } finally {
    h.app.renderer.destroy()
  }
})

test("受保护子代理拒绝手动改模型", async () => {
  const h = await render({
    selections: [{ kind: "model" }],
    keptSubagents: { worker: true },
  })
  try {
    await h.app.waitForFrame((frame) => frame.includes("实现接口"))
    const title = h.app.renderer.root.findDescendantById("sidebar.agents.title.worker")!
    await h.app.mockMouse.click(title.x, title.y)
    await h.app.flush()
    await h.app.waitFor(() => h.toasts.some((message) => message.includes("受保护")))
    expect(h.switched.length).toBe(0)
    expect(h.toasts.at(-1)).toContain("已受保护")
  } finally {
    h.app.renderer.destroy()
  }
})

test("运行中的子代理先中断再切换并 steer 续跑", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      {
        id: "busy",
        parentID: "root",
        title: "运行中",
        agent: "executor",
        model: flash,
        time: { created: 2, updated: 400, busy: 400 },
      },
    ],
    defaultPolicy: "inherit",
  })
  try {
    await h.app.flush()
    h.setRootModel(nextModel)
    await h.app.waitFor(() => h.sentPrompts.length > 0, 8000)
    expect(h.calls).toEqual(["interrupt:busy", "switch:busy", "prompt:busy"])
    expect(h.sentPrompts[0]!.delivery).toBe("steer")
  } finally {
    h.app.renderer.destroy()
  }
})

test("失败的切换逐项明示", async () => {
  const h = await render({
    sessions: [
      { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
      { id: "bad", parentID: "root", title: "失败", agent: "executor", model: flash, time: { created: 2, updated: 400 } },
    ],
    defaultPolicy: "inherit",
    failSwitchFor: "bad",
  })
  try {
    await h.app.flush()
    h.setRootModel(nextModel)
    await h.app.waitFor(() => h.toasts.some((message) => message.includes("失败")))
    expect(h.switched.length).toBe(0)
    expect(h.toasts.at(-1)).toContain("模型不可用")
  } finally {
    h.app.renderer.destroy()
  }
})
