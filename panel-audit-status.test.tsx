/** @jsxImportSource @opentui/solid */
/**
 * 面板状态派生的响应式审查：会话状态只变、列表长度不变时，
 * 头部「运行中 N」与行状态必须一起刷新；淘汰入口也不能漏掉这类转换。
 *
 * 假上下文按宿主的数据层建模（Solid store）：会话信息在 info、活跃标记在 active，
 * 因此状态变化是真的响应式信号，而不是每次都返回新数组的假信号。
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

/** 会话消息：面板的 ctx 读数与失败重试行都读它。 */
type Message = {
  id?: string
  type?: string
  status?: string
  finish?: string
  outcome?: string
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  error?: unknown
  retry?: { attempt?: number; at?: number; error?: unknown }
  time?: { created?: number; completed?: number }
}

const rootModel = { providerID: "p", id: "root" }
const models = [{ ...rootModel, name: "Root Model" }]

/** 与宿主一致的数据层：info 存会话信息，active 存活跃标记，messages 存会话消息。 */
function harness(options?: {
  children?: Session[]
  instructions?: Record<string, unknown>
  maxSubagents?: number
  /** 挂载前就处于运行中的会话 id。 */
  active?: string[]
  /** 会话 id → 消息列表。 */
  messages?: Record<string, Message[]>
}) {
  const root: Session = { id: "root", title: "root", agent: "build", model: rootModel, time: { created: 1, updated: 500 } }
  const children = options?.children ?? [
    { id: "child", parentID: "root", title: "实现接口", agent: "executor", model: rootModel, time: { created: 2, updated: 400 } },
  ]
  const [store, setStore] = createStore<{
    info: Record<string, Session>
    active: Record<string, string>
    messages: Record<string, Message[]>
  }>({
    info: { root, ...Object.fromEntries(children.map((item) => [item.id, item])) },
    active: Object.fromEntries((options?.active ?? []).map((id) => [id, "running"])),
    messages: { ...(options?.messages ?? {}) },
  })
  const familyOf = (sessionID: string) => {
    const seen = new Set<string>()
    let current = store.info[sessionID]
    while (current?.parentID && !seen.has(current.id)) {
      seen.add(current.id)
      current = store.info[current.parentID]
    }
    const rootID = current?.id ?? sessionID
    return Object.values(store.info)
      .filter((item) => {
        let node = item
        const guard = new Set<string>()
        while (node?.parentID && !guard.has(node.id)) {
          guard.add(node.id)
          node = store.info[node.parentID]
        }
        return (node?.id ?? item.id) === rootID
      })
      .map((item) => item.id)
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
        maxSubagents: options?.maxSubagents ?? 5,
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
  const removed: string[] = []
  const toasts: string[] = []
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
        root: (sessionID: string) => {
          let current = store.info[sessionID]
          const seen = new Set<string>()
          while (current?.parentID && !seen.has(current.id)) {
            seen.add(current.id)
            current = store.info[current.parentID]
          }
          return current?.id ?? sessionID
        },
        get: (id: string) => store.info[id],
        list: () => Object.values(store.info).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)),
        family: (id: string) => familyOf(id),
        status: (id: string) => store.active[id] ?? "idle",
        message: { list: (id: string) => store.messages[id] ?? [], sync: async () => {} },
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
        create: async () => ({ id: "created" }),
        prompt: async () => {},
        interrupt: async () => {},
        remove: async ({ sessionID }: { sessionID: string }) => {
          removed.push(sessionID)
          setStore(
            produce((draft: any) => {
              delete draft.info[sessionID]
              delete draft.active[sessionID]
            }),
          )
        },
        synthetic: async () => ({ id: "syn_1" }),
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
        select: async () => undefined,
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
    store,
    setStore,
    settings,
    puts,
    removes,
    removed,
    toasts,
    /** 只改活跃状态，列表长度与顺序都不变。 */
    setStatus: (id: string, status: string) => setStore("active", id, status),
    /** 只改结果与时间戳，列表长度不变。 */
    finish: (id: string, outcome: "succeeded" | "failed" | "interrupted") =>
      setStore(
        "info",
        id,
        produce((draft: any) => {
          draft.outcome = outcome
          draft.time = { ...draft.time, idle: Date.now() }
        }),
      ),
    /** 模拟宿主删除会话：会话从列表里消失。 */
    removeSession: (id: string) =>
      setStore(
        produce((draft: any) => {
          delete draft.info[id]
          delete draft.active[id]
        }),
      ),
    /** 改会话消息：面板的 ctx 读数与失败重试行跟着变。 */
    setMessages: (id: string, messages: Message[]) => setStore("messages", id, messages),
  }
}

async function render(options?: Parameters<typeof harness>[0]) {
  const h = harness(options)
  const preferencePath = path.join(mkdtempSync(path.join(tmpdir(), "panel-audit-")), "model.json")
  const app = await testRender(
    () => (
      <SidebarAgents
        context={h.context as never}
        sessionID="root"
        preferencePath={preferencePath}
        criticDir={path.join(tmpdir(), "panel-audit-critic-empty")}
      />
    ),
    { width: 100, height: 30 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("子代理"))
  return { app, ...h }
}

test("状态只变、长度不变：运行数与行状态一起刷新", async () => {
  const h = await render()
  try {
    expect(h.app.captureCharFrame()).toContain("运行中 0")

    h.setStatus("child", "running")
    await h.app.flush()
    const runningFrame = await h.app.waitForFrame((frame) => frame.includes("运行中 1"))
    expect(runningFrame).toContain("运行中 1")
    expect(runningFrame).toContain("●")

    h.setStatus("child", "idle")
    await h.app.flush()
    const idleFrame = await h.app.waitForFrame((frame) => frame.includes("运行中 0"))
    expect(idleFrame).toContain("运行中 0")
  } finally {
    h.app.renderer.destroy()
  }
})

test("结果只变、长度不变：行状态与运行数一起刷新", async () => {
  const h = await render()
  try {
    h.finish("child", "succeeded")
    await h.app.flush()
    const frame = await h.app.waitForFrame((value) => value.includes("已完成"))
    expect(frame).toContain("已完成")
    expect(frame).toContain("运行中 0")
  } finally {
    h.app.renderer.destroy()
  }
})

test("critic 复核会话不占子代理名额：计数与淘汰都不算它", async () => {
  const h = await render({
    maxSubagents: 1,
    instructions: { "superagent.max-subagents": "1" },
    children: [
      { id: "child", parentID: "root", title: "正常子代理", agent: "executor", model: rootModel, time: { created: 2, updated: 400 } },
      { id: "critic", parentID: "root", title: "Critic: 复核 正常子代理", agent: "explore", model: rootModel, time: { created: 3, updated: 300 } },
    ],
  })
  try {
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const frame = h.app.captureCharFrame()
    // 复核会话不是子代理：不占名额、不触发淘汰，也不该把正常子代理挤掉。
    expect(frame).toContain("子代理    1/1")
    expect(h.removed).toEqual([])
  } finally {
    h.app.renderer.destroy()
  }
})

test("淘汰入口不漏状态转换：超限且全在跑时，收尾即按上限淘汰", async () => {
  const h = await render({
    maxSubagents: 2,
    instructions: { "superagent.max-subagents": "2" },
    active: ["older", "middle", "newest"],
    children: [
      { id: "older", parentID: "root", title: "旧的", agent: "executor", model: rootModel, time: { created: 2, updated: 400 } },
      { id: "middle", parentID: "root", title: "中的", agent: "executor", model: rootModel, time: { created: 3, updated: 300 } },
      { id: "newest", parentID: "root", title: "新的", agent: "executor", model: rootModel, time: { created: 4, updated: 200 } },
    ],
  })
  try {
    // 三个子会话都在跑：超额但没有可淘汰对象，谁也不该被删。
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.removed).toEqual([])

    // 只有状态变了（长度不变）：收尾的旧子代理应立刻让位，不必等下一次派发。
    h.setStatus("older", "idle")
    await h.app.flush()
    await h.app.waitFor(() => h.removed.length > 0, 5000)
    expect(h.removed).toEqual(["older"])
  } finally {
    h.app.renderer.destroy()
  }
})

test("淘汰入口不漏结果转换：超限且全在跑时，落结果即按上限淘汰", async () => {
  const h = await render({
    maxSubagents: 2,
    instructions: { "superagent.max-subagents": "2" },
    active: ["older", "middle", "newest"],
    children: [
      { id: "older", parentID: "root", title: "旧的", agent: "executor", model: rootModel, time: { created: 2, updated: 400 } },
      { id: "middle", parentID: "root", title: "中的", agent: "executor", model: rootModel, time: { created: 3, updated: 300 } },
      { id: "newest", parentID: "root", title: "新的", agent: "executor", model: rootModel, time: { created: 4, updated: 200 } },
    ],
  })
  try {
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.removed).toEqual([])

    // 结果落库但状态仍在跑：活跃优先于残留结果，不能淘汰。
    h.finish("older", "failed")
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.removed).toEqual([])

    // 状态收尾：长度不变也要立刻按上限让位。
    h.setStatus("older", "idle")
    await h.app.flush()
    await h.app.waitFor(() => h.removed.length > 0, 5000)
    expect(h.removed).toEqual(["older"])
  } finally {
    h.app.renderer.destroy()
  }
})

test("busy 也算运行中：计数与行状态一致", async () => {
  const h = await render()
  try {
    h.setStatus("child", "busy")
    await h.app.flush()
    const frame = await h.app.waitForFrame((value) => value.includes("运行中 1"))
    expect(frame).toContain("运行中 1")
    expect(frame).toContain("进行中")
  } finally {
    h.app.renderer.destroy()
  }
})

test("失败与中断各有行状态", async () => {
  const h = await render()
  try {
    h.finish("child", "failed")
    await h.app.flush()
    const failed = await h.app.waitForFrame((value) => value.includes("失败"))
    expect(failed).toContain("✗")

    h.finish("child", "interrupted")
    await h.app.flush()
    const interrupted = await h.app.waitForFrame((value) => value.includes("已中断"))
    expect(interrupted).toContain("Ⅱ")
  } finally {
    h.app.renderer.destroy()
  }
})

test("删除子代理后行与计数一起消失", async () => {
  const h = await render()
  try {
    expect(h.app.captureCharFrame()).toContain("实现接口")
    h.removeSession("child")
    await h.app.flush()
    const frame = await h.app.waitForFrame((value) => !value.includes("实现接口"))
    expect(frame).not.toContain("实现接口")
    expect(frame).toContain("子代理    0/5")
    expect(frame).toContain("暂无子代理，分配任务后显示")
  } finally {
    h.app.renderer.destroy()
  }
})

test("嵌套后代不算名额：root 作用域证据", async () => {
  const h = await render({
    active: ["grandchild"],
    children: [
      { id: "child", parentID: "root", title: "直接子代理", agent: "executor", model: rootModel, time: { created: 2, updated: 400 } },
      { id: "grandchild", parentID: "child", title: "嵌套子代理", agent: "executor", model: rootModel, time: { created: 3, updated: 300 } },
    ],
  })
  try {
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const frame = h.app.captureCharFrame()
    // 嵌套子代理在树里可见、在跑，但只算 root 的直接子代理名额。
    expect(frame).toContain("嵌套子代理")
    expect(frame).toContain("子代理    1/5")
    expect(frame).toContain("运行中 0")
  } finally {
    h.app.renderer.destroy()
  }
})

test("压缩后 ctx 读数回落", async () => {
  const tokens = (input: number) => ({
    input,
    output: 100,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })
  const h = await render({
    messages: {
      child: [
        { id: "m1", type: "assistant", status: "completed", tokens: tokens(120_000) },
      ],
    },
  })
  try {
    await h.app.flush()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.app.captureCharFrame()).toContain("ctx 120k")

    // 压缩完成后，最近一次 assistant 的输入规模变小，读数随之下降。
    h.setMessages("child", [
      { id: "m1", type: "assistant", status: "completed", tokens: tokens(120_000) },
      { id: "m2", type: "compaction", status: "completed" },
      { id: "m3", type: "assistant", status: "completed", tokens: tokens(1_200) },
    ])
    await h.app.flush()
    const frame = await h.app.waitForFrame((value) => value.includes("ctx 1.2k"))
    expect(frame).toContain("ctx 1.2k")
    expect(frame).not.toContain("ctx 120k")
  } finally {
    h.app.renderer.destroy()
  }
})

test("失败重试行随消息刷新", async () => {
  // 「正在重试」只在会话仍活跃时出现：夹具必须让 child 处于运行中。
  const h = await render({ active: ["child"] })
  try {
    await h.app.flush()
    expect(h.app.captureCharFrame()).not.toContain("上次失败")
    h.setMessages("child", [
      {
        id: "m1",
        type: "assistant",
        status: "completed",
        finish: "error",
        error: { type: "provider_error", message: "上游 503" },
        retry: { attempt: 2, at: 1_800_000_000_000 },
        time: { created: 1_800_000_000_000, completed: 1_800_000_001_000 },
      },
    ])
    await h.app.flush()
    const frame = await h.app.waitForFrame((value) => value.includes("正在重试"))
    expect(frame).toContain("正在重试")
    expect(frame).toContain("上次失败：上游 503")

    // 执行收尾后不再是「正在重试」：同一行切到失败态文案，失败原因保留。
    h.setStatus("child", "idle")
    await h.app.flush()
    const failedFrame = await h.app.waitForFrame((value) => value.includes("失败 · 重试 #2"))
    expect(failedFrame).toContain("上次失败：上游 503")
  } finally {
    h.app.renderer.destroy()
  }
})
