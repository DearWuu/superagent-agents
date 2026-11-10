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

async function mount(
  options: {
    current?: { providerID: string; id: string }
    groups?: PickerGroup[]
    providerNames?: Record<string, string>
    height?: number
    onSelect?: (m: ModelInfo) => void
  } = {},
) {
  const commands: Command[] = []
  const favorites = new Set(["acme/alpha"])
  const picked: ModelInfo[] = []
  const favorited: ModelInfo[] = []
  const closes: string[] = []
  const activeGroups = options.groups ?? groups
  const app = await testRender(
    () => (
      <ModelPicker
        context={{ theme: theme(), keymap: { layer: (factory: () => { commands?: Command[] }) => void commands.push(...(factory().commands ?? [])) } } as never}
        title="Select model"
        groups={() => activeGroups}
        favorites={() => favorites}
        providerName={(providerID) =>
          options.providerNames?.[providerID] ?? providerID.charAt(0).toUpperCase() + providerID.slice(1)
        }
        current={options.current}
        onFavorite={(item) => favorited.push(item)}
        onSelect={(item) => {
          picked.push(item)
          options.onSelect?.(item)
        }}
        onClose={() => closes.push("closed")}
      />
    ),
    { width: 80, height: options.height ?? 40, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Select model"))
  // The input ref focuses on a short timer; let it run before tests type.
  await new Promise((resolve) => setTimeout(resolve, 10))
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

test("search finds Recent and Favorites entries by provider", async () => {
  const flash = model("qoder", "qwen3-8-flash", "Qwen3 8 Flash")
  const max = model("qoder", "qwen3-8-max", "Qwen3 8 Max")
  const deepseek = model("qoder", "deepseek-flash", "DeepSeek Flash")
  const picker = await mount({
    groups: [
      { title: "Favorites", models: [max as never] },
      { title: "Recent", models: [flash as never] },
      { title: "Qoder", models: [deepseek as never] },
    ],
  })
  try {
    await picker.app.mockInput.typeText("qoder")
    // A query flattens sections; wait for the header to disappear so the
    // assertions inspect the filtered list rather than the initial frame.
    await picker.app.waitForFrame((frame) => !frame.includes("Favorites"))
    const frame = picker.app.captureCharFrame()
    expect(frame).toContain("Qwen3 8 Flash")
    expect(frame).toContain("Qwen3 8 Max")
    expect(frame).toContain("DeepSeek Flash")
    expect(frame).not.toContain("No results found")
  } finally {
    picker.app.renderer.destroy()
  }
})

test("filtered results beyond the viewport remain reachable by keyboard", async () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    model("qoder", `qoder-${index}`, `Qoder Search ${String(index).padStart(2, "0")}`),
  )
  const picker = await mount({ groups: [{ title: "Recent", models: many as never[] }], height: 20 })
  try {
    await picker.app.mockInput.typeText("qoder")
    await picker.app.waitForFrame((frame) => frame.includes("Qoder Search 00"))
    expect(picker.app.captureCharFrame()).not.toContain("Qoder Search 11")

    picker.press("end")
    const tail = await picker.app.waitForFrame((frame) => frame.includes("Qoder Search 11"))
    expect(tail).not.toContain("Qoder Search 00")

    picker.press("home")
    await picker.app.waitForFrame((frame) => frame.includes("Qoder Search 00"))
    picker.press("pagedown")
    await picker.app.waitForFrame((frame) => frame.includes("Qoder Search 10"))
  } finally {
    picker.app.renderer.destroy()
  }
})

test("search still matches model id", async () => {
  const flash = model("qoder", "qwen3-8-flash", "Qwen3 8 Flash")
  const picker = await mount({ groups: [{ title: "Recent", models: [flash as never] }] })
  try {
    await picker.app.mockInput.typeText("qwen3-8-flash")
    const frame = await picker.app.waitForFrame((value) => !value.includes("Recent"))
    expect(frame).toContain("Qwen3 8 Flash")
  } finally {
    picker.app.renderer.destroy()
  }
})

test("provider display name and id distinguish same-name models", async () => {
  const acme = model("acme-labs", "shared", "Shared")
  const gizmo = model("gizmo", "shared", "Shared")
  const activeGroups = [{ title: "Recent", models: [acme as never, gizmo as never] }]
  const matchingRows = async (needle: string) => {
    const picker = await mount({ groups: activeGroups, providerNames: { "acme-labs": "Acme Labs" } })
    try {
      await picker.app.mockInput.typeText(needle)
      // A query flattens sections, so the section header disappearing proves
      // the input reached the filter before the row count is read.
      await picker.app.waitForFrame((frame) => !frame.includes("Recent"))
      return (picker.app.captureCharFrame().match(/Shared/g) ?? []).length
    } finally {
      picker.app.renderer.destroy()
    }
  }
  expect(await matchingRows("acme labs")).toBe(1)
  expect(await matchingRows("acme-labs")).toBe(1)
  expect(await matchingRows("gizmo")).toBe(1)
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