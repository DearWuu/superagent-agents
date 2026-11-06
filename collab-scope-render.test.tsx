/** @jsxImportSource @opentui/solid */
/**
 * 用真实 SidebarAgents 组件离屏渲染两个不同 family root：
 * root A 的 `superagent.collab-enabled=false`，root B 缺省。
 * 结果写文本帧，证明 A 只显示停用一行、B 照常显示协作面板。
 */
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { createStore, produce } from "solid-js/store"
import { expect, test, mock } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (value: unknown) => value } }))
const { SidebarAgents, STORAGE_KEY, SUPERAGENT_DEFAULTS } = await import("./index")

const color = (value: number) => RGBA.fromInts(value, value, value)
const accent = RGBA.fromInts(157, 124, 216)

function theme() {
  const tokens = {
    text: {
      base: color(255),
      muted: color(128),
      formfield: { focused: color(240), selected: color(200) },
      action: { primary: { focused: color(10) } },
    },
    background: {
      action: { primary: { focused: RGBA.fromInts(250, 178, 131) } },
      formfield: { focused: color(40) },
    },
    hue: { accent: { 200: accent } },
    surface: () => tokens,
  }
  return tokens as never
}

type Session = {
  id: string
  parentID?: string
  title?: string
  time: { created: number; updated: number; busy?: number; idle?: number }
}

function harness(rootID: string, entries: Record<string, Record<string, string | number>>) {
  const now = Date.now()
  const sessions: Session[] =
    rootID === "ses_a_root"
      ? [{ id: "ses_a_root", title: "A 会话", time: { created: now - 20_000, updated: now } }]
      : [
          { id: "ses_b_root", title: "B 会话", time: { created: now - 20_000, updated: now } },
          {
            id: "ses_b_child",
            parentID: "ses_b_root",
            title: "实现登录页",
            time: { created: now - 10_000, updated: now, busy: now - 5_000, idle: now - 1_000 },
          },
        ]
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const rootOf = (sessionID: string) => {
    let current = byId.get(sessionID)
    const seen = new Set<string>()
    while (current?.parentID && !seen.has(current.id)) {
      seen.add(current.id)
      current = byId.get(current.parentID)
    }
    return current?.id ?? sessionID
  }
  const family = (id: string) => sessions.filter((session) => rootOf(session.id) === id).map((session) => session.id)
  const entryState: Record<string, Record<string, unknown>> = structuredClone(entries)
  const [settings, updateSettings] = createStore<any>({
    version: 3,
    autoModels: [...SUPERAGENT_DEFAULTS.autoModels],
    roots: {},
  })
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
        status: () => "idle",
        message: { list: () => [] },
      },
      location: {
        model: { list: () => [] },
        provider: { list: () => [] },
      },
    },
    client: {
      experimental: {
        session: {
          instructions: {
            entry: {
              list: async ({ sessionID }: { sessionID: string }) =>
                Object.entries(entryState[sessionID] ?? {}).map(([key, value]) => ({ key, value })),
              put: async ({ sessionID, key, value }: { sessionID: string; key: string; value: unknown }) => {
                entryState[sessionID] = { ...(entryState[sessionID] ?? {}), [key]: value }
              },
              remove: async ({ sessionID, key }: { sessionID: string; key: string }) => {
                if (entryState[sessionID]) delete entryState[sessionID][key]
              },
            },
          },
        },
      },
      session: {
        switchModel: async () => {},
        compact: async () => {},
        create: async () => ({}),
        prompt: async () => {},
        interrupt: async () => {},
        remove: async () => {},
      },
    },
    keymap: { layer: () => {} },
    ui: {
      model: { current: () => undefined },
      dialog: {
        alert: async () => {},
        clear: () => {},
        confirm: async () => true,
        prompt: async () => undefined,
        select: async () => undefined,
        show: () => {},
      },
      router: { navigate: () => {} },
      toast: { show: () => {} },
    },
  } as never
  return { context, entryState, settings }
}

async function render(rootID: string, entries: Record<string, Record<string, string | number>>) {
  const h = harness(rootID, entries)
  const preferencePath = path.join(mkdtempSync(path.join(tmpdir(), "superagent-render-")), "model.json")
  const app = await testRender(
    () => (
      <SidebarAgents
        context={h.context}
        sessionID={rootID}
        preferencePath={preferencePath}
        criticDir={path.join(tmpdir(), "superagent-critic-empty")}
      />
    ),
    { width: 90, height: 24 },
  )
  app.renderer.start()
  return { app, ...h }
}

test("真实组件离屏：root A 停用只留一行，root B 缺省照常显示面板", async () => {
  const a = await render("ses_a_root", {
    ses_a_root: { "superagent.collab-enabled": "false" },
  })
  const b = await render("ses_b_root", {
    ses_b_root: { "superagent.max-subagents": 5 },
  })
  try {
    const aFrame = await a.app.waitForFrame((frame) => frame.includes("agents协作已停用"))
    const bFrame = await b.app.waitForFrame((frame) => frame.includes("实现登录页"))

    expect(aFrame).toContain("agents协作已停用")
    expect(aFrame).not.toContain("子代理")
    expect(bFrame).toContain("agents协作")
    expect(bFrame).not.toContain("agents协作已停用")
    expect(bFrame).toContain("子代理")
    expect(bFrame).toContain("实现登录页")

    const out = process.env.COLLAB_RENDER_OUT ?? path.join(tmpdir(), "superagent-collab-scope-render.txt")
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(
      out,
      [
        "=== root A: superagent.collab-enabled=false ===",
        a.app.captureCharFrame(),
        "",
        "=== root B: entry missing (default enabled) ===",
        b.app.captureCharFrame(),
        "",
      ].join("\n"),
      "utf8",
    )
    expect(a.entryState.ses_a_root!["superagent.collab-enabled"]).toBe("false")
    expect(b.settings.roots.ses_b_root).toBeDefined()
  } finally {
    a.app.renderer.destroy()
    b.app.renderer.destroy()
  }
})