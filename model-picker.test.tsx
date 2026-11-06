/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { expect, test } from "bun:test"
import { mock } from "bun:test"

mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (value: unknown) => value } }))
const { ModelPicker } = await import("./index")

type PickerGroup = { title: string; models: ModelInfo[] }

type ModelInfo = Parameters<typeof ModelPicker>[0]["groups"] extends () => (infer Group)[]
  ? Group extends { models: (infer Model)[] }
    ? Model
    : never
  : never

const model = (providerID: string, id: string, name: string, input = 1) =>
  ({ providerID, id, name, cost: [{ input }] }) as unknown as ModelInfo

const alpha = model("acme", "alpha", "Alpha")
const beta = model("acme", "beta", "Beta")
const gamma = model("gizmo", "gamma", "Gamma")
const free = model("opencode", "free", "Free One", 0)

const groups: PickerGroup[] = [
  { title: "Favorites", models: [alpha as never] },
  { title: "Recent", models: [beta as never] },
  { title: "Acme", models: [alpha as never] },
  { title: "Gizmo", models: [gamma as never] },
  { title: "Free", models: [free as never] },
]

const color = (value: number) => RGBA.fromInts(value, value, value)
const accent = RGBA.fromInts(157, 124, 216)

type Command = { bind: string; run: () => void }

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

async function mount(options: { current?: { providerID: string; id: string }; onSelect?: (m: ModelInfo) => void } = {}) {
  const commands: Command[] = []
  const favorites = new Set(["acme/alpha"])
  const picked: ModelInfo[] = []
  const favorited: ModelInfo[] = []
  const closes: string[] = []
  const app = await testRender(
    () => (
      <ModelPicker
        context={{ theme: theme(), keymap: { layer: (factory: () => { commands?: Command[] }) => void commands.push(...(factory().commands ?? [])) } } as never}
        title="Select model"
        groups={() => groups}
        favorites={() => favorites}
        providerName={(providerID) => providerID.charAt(0).toUpperCase() + providerID.slice(1)}
        current={options.current}
        onFavorite={(item) => favorited.push(item)}
        onSelect={(item) => {
          picked.push(item)
          options.onSelect?.(item)
        }}
        onClose={() => closes.push("closed")}
      />
    ),
    { width: 80, height: 40, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Select model"))
  const press = (bind: string) => commands.find((command) => command.bind.split(",").includes(bind))!.run()
  return { app, picked, favorited, closes, press }
}

test("sections, inline provider names and trailing markers render", async () => {
  const picker = await mount({ current: { providerID: "acme", id: "beta" } })
  try {
    const frame = picker.app.captureCharFrame()
    expect(frame).toContain("Favorites")
    expect(frame).toContain("Recent")
    expect(frame).toContain("Gizmo")
    expect(frame).toMatch(/Alpha +Acme +\*/)
    expect(frame).toMatch(/Beta +Acme/)
    expect(frame).toContain("● Beta")
    expect(frame).toMatch(/Free One +Opencode +Free/)
    expect(frame).toContain("Favorite ctrl+f")
    expect(frame).toContain("Search")
    expect(frame).toContain("esc")
  } finally {
    picker.app.renderer.destroy()
  }
})

test("the selection moves, enter picks it and ctrl+f favorites it", async () => {
  const picker = await mount({ current: { providerID: "acme", id: "alpha" } })
  try {
    picker.press("down")
    await picker.app.flush()
    picker.press("return")
    await picker.app.flush()
    expect(picker.picked.map((item) => item.id)).toEqual(["beta"])

    picker.press("ctrl+f")
    expect(picker.favorited.map((item) => item.id)).toEqual(["beta"])
  } finally {
    picker.app.renderer.destroy()
  }
})

test("typing filters to a flat list without section titles", async () => {
  const picker = await mount()
  try {
    await picker.app.mockInput.typeText("gamm")
    await picker.app.waitForFrame((frame) => !frame.includes("Favorites"))
    const frame = picker.app.captureCharFrame()
    expect(frame).not.toContain("Beta")
    expect(frame).toMatch(/Gamma +Gizmo/)
    picker.press("return")
    await picker.app.flush()
    expect(picker.picked.map((item) => item.id)).toEqual(["gamma"])
  } finally {
    picker.app.renderer.destroy()
  }
})

test("esc closes the dialog", async () => {
  const picker = await mount()
  try {
    const lines = picker.app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("esc"))
    await picker.app.mockMouse.click(lines[row]!.indexOf("esc") + 1, row)
    await picker.app.flush()
    expect(picker.closes).toEqual(["closed"])
  } finally {
    picker.app.renderer.destroy()
  }
})