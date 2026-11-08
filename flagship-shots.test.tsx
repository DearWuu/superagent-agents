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
    id: "flagship",
    parentID: "root",
    title: "设计验收协议",
    agent: "executor",
    model: rootModel,
    metadata: { "superagent.flagship": true },
    time: { created: 2, updated: 400 },
  },
  {
    id: "worker",
    parentID: "root",
    title: "实现侧栏标记",
    agent: "executor",
    model: flash,
    time: { created: 3, updated: 300 },
  },
]
const byId = new Map(sessions.map((item) => [item.id, item]))
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
      policies: { worker: "fixed" },
      defaultPolicy: "inherit",
      maxSubagents: 5,
      expanded: {},
      initialized: { root: true },
      keptSubagents: {},
      assignmentPrompt: "",
      oversight: { pins: { models: {}, sessions: {} }, capabilityOverrides: {}, history: {}, lastResolved: {} },
    },
  },
})
const [menu, setMenu] = createSignal<{ title: string; options: Array<{ title: string; description?: string }> }>()
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
      list: () => sessions,
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
    session: { switchModel: async () => {}, compact: async () => {}, create: async () => ({ id: "x" }), prompt: async () => {}, interrupt: async () => {}, remove: async () => {} },
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
        return undefined
      },
      show: () => {},
    },
    router: { navigate: () => {} },
    toast: { show: () => {} },
  },
}

async function capture(ready: string, after?: (app: any) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-shots-"))
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
    { width: 80, height: 44 },
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

test("panel hides flagship count and marker", async () => {
  const shot = await capture("Superagent · 重构右栏编排")
  expect(shot.charFrame).not.toContain("旗舰")
  save("flagship-panel", shot)
})

test("settings menu flagship limit", async () => {
  const shot = await capture("Superagent · 重构右栏编排", async (app) => {
    const title = app.renderer.root.findDescendantById("sidebar.agents.settings")!
    await app.mockMouse.click(title.x, title.y)
    await app.waitForFrame((frame) => frame.includes("旗舰子代理数量"))
  })
  expect(shot.charFrame).toContain("旗舰子代理数量")
  expect(shot.charFrame).toContain("仍计入子代理总上限")
  save("flagship-settings", shot)
})

test("oversight acceptance descriptions", async () => {
  const shot = await capture("Superagent · 重构右栏编排", async (app) => {
    const root = app.renderer.root.findDescendantById("sidebar.agents.oversight")!
    await app.mockMouse.click(root.x, root.y)
    await app.waitForFrame((frame) => frame.includes("结果验收（低风险）"))
  })
  expect(shot.charFrame).toContain("证据验收（默认）")
  expect(shot.charFrame).toContain("审计验收（独立 critic）")
  save("flagship-oversight", shot)
})