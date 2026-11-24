/** @jsxImportSource @opentui/solid */
import { expect, test, mock } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore } from "solid-js/store"
import { createSignal, Show, For } from "solid-js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (value: unknown) => value } }))
const { SidebarAgents } = await import("./index")

const color = (value: number) => RGBA.fromInts(value, value, value)
const theme = (() => {
  const tokens = {
    text: {
      base: color(255),
      muted: color(150),
      formfield: { focused: color(240), selected: color(200) },
      action: { primary: { focused: color(10) } },
      feedback: { warning: { base: color(255) } },
    },
    background: { action: { primary: { focused: color(250) } }, formfield: { focused: color(40) } },
    hue: { accent: { 200: color(157) } },
    surface: () => tokens,
  }
  return tokens as never
})()

const rootModel = { providerID: "acme", id: "k3.1-pro" }
const flash = { providerID: "acme", id: "flash" }
const sessions = [
  { id: "root", title: "重构右栏编排", agent: "build", model: rootModel, time: { created: 1, updated: 500 } },
  {
    id: "worker",
    parentID: "root",
    title: "实现侧栏标记",
    agent: "executor",
    model: flash,
    time: { created: 2, updated: 400 },
  },
  {
    id: "locked",
    parentID: "root",
    title: "保留的子代理",
    agent: "executor",
    model: flash,
    time: { created: 3, updated: 300 },
  },
]
const byId = new Map(sessions.map((item) => [item.id, item]))
const [sessionVersion, setSessionVersion] = createSignal(0)
const rootOf = (id: string) => {
  let current = byId.get(id)
  while (current?.parentID) current = byId.get(current.parentID)
  return current?.id ?? id
}
const [settings] = createStore<any>({
  version: 2,
  autoModels: [],
  roots: {
    root: {
      policies: {},
      defaultPolicy: "inherit",
      maxSubagents: 5,
      expanded: {},
      initialized: { root: true },
      keptSubagents: { locked: true },
      assignmentPrompt: "",
      oversight: { pins: { models: {}, sessions: {} }, capabilityOverrides: {}, history: {}, lastResolved: {} },
    },
  },
})
const [menu, setMenu] = createSignal<{ title: string; options: Array<{ title: string; description?: string }> }>()
const removed: string[] = []
const created: unknown[] = []
const prompted: unknown[] = []
/** 面板手动操作回传给 root 的 synthetic 通知。 */
const synthetics: any[] = []
/** toast 文案：用来确认动作本身真的执行了。 */
const toasts: string[] = []
/** 故障注入：删除/压缩失败时面板必须 toast 且不投递手动操作通知。 */
let failRemove = false
let failCompact = false
/** The action the row menu returns; unset means the user just opened the menu. */
let nextSelection: unknown
/** 连续多个弹窗的返回值：行菜单 + 后续弹窗按顺序取。 */
const selectionQueue: unknown[] = []
const context = {
  theme,
  storage: {
    store: () => [
      settings,
      async (mutation: (draft: any) => void) => {
        mutation(settings)
      },
    ],
  },
  data: {
    session: {
      root: rootOf,
      get: (id: string) => byId.get(id),
      list: () => {
        sessionVersion()
        return [...sessions]
      },
      family: (id: string) => sessions.filter((item) => rootOf(item.id) === id).map((item) => item.id),
      status: () => "idle",
      message: { list: () => [] },
    },
    location: {
      model: { list: () => [{ ...rootModel, name: "K3.1 Pro" }, { ...flash, name: "Flash 2.5" }] },
      provider: { list: () => [] },
    },
  },
  client: {
    experimental: {
      session: { instructions: { entry: { list: async () => [], put: async () => {}, remove: async () => {} } } },
    },
    session: {
      switchModel: async () => {},
      compact: async () => {
        if (failCompact) throw new Error("compact failed")
      },
      create: async (input: unknown) => {
        created.push(input)
        return { id: "x" }
      },
      prompt: async (input: unknown) => {
        prompted.push(input)
      },
      interrupt: async () => {},
      remove: async ({ sessionID }: { sessionID: string }) => {
        if (failRemove) throw new Error("remove failed")
        removed.push(sessionID)
        const index = sessions.findIndex((item) => item.id === sessionID)
        if (index >= 0) sessions.splice(index, 1)
        byId.delete(sessionID)
        setSessionVersion((version) => version + 1)
      },
      synthetic: async (input: unknown) => {
        synthetics.push(input)
        return { id: "syn_1" }
      },
    },
  },
  keymap: { layer: () => {} },
  ui: {
    model: { current: () => undefined, select: undefined },
    dialog: {
      alert: async () => {},
      clear: () => setMenu(undefined),
      confirm: async () => true,
      prompt: async () => undefined,
      select: async (options: any) => {
        setMenu({ title: options.title, options: options.options })
        const picked = selectionQueue.length > 0 ? selectionQueue.shift() : nextSelection
        if (selectionQueue.length === 0) nextSelection = undefined
        if (picked !== undefined) setMenu(undefined)
        return picked
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

async function capture(ready: string, after?: (app: any) => Promise<void>) {
  setMenu(undefined)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delete-keep-shots-"))
  const app = await testRender(
    () => (
      <box flexDirection="column">
        <SidebarAgents
          context={context as never}
          sessionID="root"
          preferencePath={path.join(directory, "model.json")}
          criticDir={path.join(directory, "critic")}
        />
        <Show when={menu()}>
          {(value) => (
            <box flexDirection="column" paddingTop={1}>
              <text fg={theme.text.base}>
                <b>{value().title}</b>
              </text>
              <For each={value().options}>
                {(option, index) => (
                  <box flexDirection="column">
                    <text fg={theme.text.base}>{`${index() === 0 ? "› " : "  "}${option.title}`}</text>
                    <Show when={option.description}>
                      <text fg={theme.text.muted}>{`    ${option.description}`}</text>
                    </Show>
                  </box>
                )}
              </For>
            </box>
          )}
        </Show>
      </box>
    ),
    { width: 90, height: 44 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(ready))
  if (after) await after(app)
  await app.flush()
  const spans = app.captureSpans()
  const charFrame = app.captureCharFrame()
  app.renderer.destroy()
  return { spans, charFrame }
}

function save(name: string, shot: Awaited<ReturnType<typeof capture>>) {
  const dir = "/tmp/oc-v2/shots"
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.txt`), shot.charFrame)
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({ cols: shot.spans.cols, rows: shot.spans.rows, lines: shot.spans.lines }),
  )
}

test("the row action menu offers the delete action and the protection note", async () => {
  const shot = await capture("实现侧栏标记", async (app) => {
    const title = app.renderer.root.findDescendantById("sidebar.agents.title.worker")!
    await app.mockMouse.click(title.x, title.y)
    await app.waitForFrame((frame) => frame.includes("删除 Subagent"))
  })
  expect(shot.charFrame).toContain("删除 Subagent")
  expect(shot.charFrame).toContain("删除该子会话及其上下文，不可恢复")
  expect(shot.charFrame).toContain("不会被自动淘汰；手动改模型需先取消保护，默认模型同步仍会生效")
  save("delete-menu", shot)
})

test("a protected subagent offers to release the protection", async () => {
  const shot = await capture("保留的子代理", async (app) => {
    const title = app.renderer.root.findDescendantById("sidebar.agents.title.locked")!
    await app.mockMouse.click(title.x, title.y)
    await app.waitForFrame((frame) => frame.includes("取消保护"))
  })
  expect(shot.charFrame).toContain("取消保护")
  expect(shot.charFrame).toContain("允许自动淘汰这个子代理，模型也可以被修改")
  save("protection-menu", shot)
})

test("the panel marks a protected subagent with the lock badge", async () => {
  const shot = await capture("保留的子代理")
  expect(shot.charFrame).toContain("🔒")
  save("protection-panel", shot)
})

test("deleting a subagent removes its row and creates nothing", async () => {
  nextSelection = { kind: "delete" }
  const shot = await capture("实现侧栏标记", async (app) => {
    const title = app.renderer.root.findDescendantById("sidebar.agents.title.worker")!
    await app.mockMouse.click(title.x, title.y)
    await app.waitFor(() => removed.includes("worker"), 8000)
  })
  expect(removed).toEqual(["worker"])
  expect(created).toEqual([])
  expect(prompted).toEqual([])
  expect(shot.charFrame).not.toContain("实现侧栏标记")
  expect(shot.charFrame).toContain("保留的子代理")
  save("delete-result", shot)
})

/** 等真实定时器：防抖通知不经过渲染帧，渲染器的 waitFor 等不到。 */
async function waitUntil(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return check()
}

/** 追加一个子会话并让面板重绘。 */
function addSession(id: string, title: string) {
  const item = {
    id,
    parentID: "root",
    title,
    agent: "executor",
    model: flash,
    time: { created: 10, updated: 200 },
  }
  sessions.push(item)
  byId.set(id, item)
  setSessionVersion((version) => version + 1)
}

test("deleting a subagent tells the Superagent that the user did it", async () => {
  addSession("victim", "被删的子代理")
  synthetics.length = 0
  selectionQueue.push({ kind: "delete" })
  await capture("被删的子代理", async (app) => {
    const title = app.renderer.root.findDescendantById("sidebar.agents.title.victim")!
    await app.mockMouse.click(title.x, title.y)
    await app.waitFor(() => synthetics.length === 1, 8000)
  })
  expect(synthetics).toHaveLength(1)
  expect(synthetics[0].sessionID).toBe("root")
  expect(synthetics[0].description).toBe("用户手动操作")
  // 手动操作通知一律 queue：成为待处理消息，不打断也不唤醒正在推理的会话。
  expect(synthetics[0].delivery).toBe("queue")
  expect(String(synthetics[0].text)).toContain("用户")
  expect(String(synthetics[0].text)).toContain("删除")
  expect(synthetics[0].metadata).toEqual({
    source: "superagent-agents",
    kind: "manual-op",
    action: "delete",
    childID: "victim",
  })
})

test("protecting a subagent tells the Superagent that the user did it", async () => {
  addSession("keeper", "被保护的子代理")
  synthetics.length = 0
  selectionQueue.push({ kind: "keep" })
  await capture("被保护的子代理", async (app) => {
    const title = app.renderer.root.findDescendantById("sidebar.agents.title.keeper")!
    await app.mockMouse.click(title.x, title.y)
    // 保护类通知有防抖窗口，不走渲染帧，用真实定时器等。
    await waitUntil(() => synthetics.length === 1)
  })
  expect(synthetics).toHaveLength(1)
  expect(synthetics[0].sessionID).toBe("root")
  expect(String(synthetics[0].text)).toContain("用户")
  expect(String(synthetics[0].text)).toContain("保护")
  expect(synthetics[0].metadata.action).toBe("keep")
  expect(synthetics[0].metadata.childID).toBe("keeper")
})

test("releasing the protection tells the Superagent that the user did it", async () => {
  synthetics.length = 0
  selectionQueue.push({ kind: "keep" })
  await capture("保留的子代理", async (app) => {
    const title = app.renderer.root.findDescendantById("sidebar.agents.title.locked")!
    await app.mockMouse.click(title.x, title.y)
    await waitUntil(() => synthetics.length === 1)
  })
  expect(synthetics).toHaveLength(1)
  expect(String(synthetics[0].text)).toContain("用户")
  expect(String(synthetics[0].text)).toContain("解除了")
  expect(synthetics[0].metadata.action).toBe("unkeep")
})

test("changing a child's model policy tells the Superagent without claiming the model switched", async () => {
  addSession("modeler", "换模型的子代理")
  synthetics.length = 0
  toasts.length = 0
  selectionQueue.push({ kind: "model" }, { kind: "auto" })
  await capture("换模型的子代理", async (app) => {
    const title = app.renderer.root.findDescendantById("sidebar.agents.title.modeler")!
    await app.mockMouse.click(title.x, title.y)
    // 策略通知有防抖窗口，不走渲染帧，用真实定时器等。
    await waitUntil(() => synthetics.length === 1)
  })
  expect(toasts.some((item) => item.includes("已设为自动"))).toBe(true)
  expect(synthetics).toHaveLength(1)
  expect(synthetics[0].sessionID).toBe("root")
  expect(synthetics[0].delivery).toBe("queue")
  // 单子代理策略只影响该子代理后续分配，不冒充全局默认策略变更。
  expect(String(synthetics[0].text)).toContain("只影响该子代理后续分配")
  expect(String(synthetics[0].text)).not.toContain("默认模型设为")
  expect(synthetics[0].metadata).toEqual({
    source: "superagent-agents",
    kind: "manual-op",
    action: "child-policy",
    childID: "modeler",
  })
})

test("删除失败：toast 失败原因，不投递手动操作通知", async () => {
  addSession("del-fail", "删除失败子代理")
  synthetics.length = 0
  toasts.length = 0
  selectionQueue.push({ kind: "delete" })
  failRemove = true
  try {
    await capture("删除失败子代理", async (app) => {
      const title = app.renderer.root.findDescendantById("sidebar.agents.title.del-fail")!
      await app.mockMouse.click(title.x, title.y)
      await waitUntil(() => toasts.some((item) => item.includes("删除失败子代理 失败")))
    })
    expect(removed).not.toContain("del-fail")
    expect(toasts.at(-1)).toContain("删除失败子代理 失败")
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(synthetics).toEqual([])
  } finally {
    failRemove = false
  }
})

test("压缩失败：toast 失败原因，不投递手动操作通知", async () => {
  addSession("compact-fail", "压缩失败子代理")
  synthetics.length = 0
  toasts.length = 0
  selectionQueue.push({ kind: "compact" })
  failCompact = true
  try {
    await capture("压缩失败子代理", async (app) => {
      const title = app.renderer.root.findDescendantById("sidebar.agents.title.compact-fail")!
      await app.mockMouse.click(title.x, title.y)
      await waitUntil(() => toasts.some((item) => item.includes("压缩失败子代理 失败")))
    })
    expect(toasts.at(-1)).toContain("压缩失败子代理 失败")
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(synthetics).toEqual([])
  } finally {
    failCompact = false
  }
})
