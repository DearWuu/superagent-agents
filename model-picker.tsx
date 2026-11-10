/** @jsxImportSource @opentui/solid */
/** TUI 的模型选择器：分组、搜索、键盘与鼠标选择。 */
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type { ModelInfo } from "./panel-types"
import { isFreeModel } from "./panel-utils"

export type PickerGroup = { title: string; models: ModelInfo[] }

/** A picker row: a section title, or a model with the section it came from. */
type PickerRow =
  | { kind: "header"; title: string }
  | { kind: "model"; model: ModelInfo; section: string; favorite: boolean }

export const pickerKey = (model: { providerID: string; id: string }) => `${model.providerID}/${model.id}`

/** Fuzzy score of a subsequence match; consecutive hits weigh more. `undefined` when it does not match. */
function pickerScore(needle: string, text: string) {
  let cursor = 0
  let score = 0
  let previous = -2
  for (let index = 0; index < text.length && cursor < needle.length; index++) {
    if (text[index] !== needle[cursor]) continue
    score += index === previous + 1 ? 2 : 1
    previous = index
    cursor++
  }
  return cursor === needle.length ? score : undefined
}

/** Searchable text for a picker row: model name/id, provider id/display name, and its section. */
function pickerSearchText(
  item: { model: ModelInfo; section: string },
  providerName: (providerID: string) => string,
) {
  return [
    item.model.name,
    item.model.id,
    item.model.providerID,
    providerName(item.model.providerID),
    item.section,
  ]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(" ")
    .toLowerCase()
}



/**
 * The bundled /models dialog, for hosts without `ui.model.select`.
 *
 * `ui.dialog.select`'s search callback flattens the list and drops section
 * titles, so this draws the dialog itself, copying OpenCode's DialogSelect:
 * section titles in the theme accent, a highlighted selection, the model name
 * with its provider on the same row, the trailing Free / favorite marker, and
 * the native keys (esc, up/down, page keys, enter, ctrl+f).
 */
export function ModelPicker(props: {
  context: Plugin.Context
  title: string
  groups: () => PickerGroup[]
  favorites: () => Set<string>
  providerName: (providerID: string) => string
  current?: { providerID: string; id: string }
  onFavorite: (model: ModelInfo) => void
  onSelect: (model: ModelInfo) => void
  onClose: () => void
}) {
  const tokens = props.context.theme
  const theme = tokens.surface("dialog")
  const accent = tokens.hue?.accent?.[200] ?? tokens.text.base
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string | undefined>(props.current ? pickerKey(props.current) : undefined)
  const dimensions = useTerminalDimensions()

  /** Empty query keeps the sections; a query flattens them, as the native picker does. */
  const rows = createMemo<PickerRow[]>(() => {
    const needle = query().trim().toLowerCase()
    const favorites = props.favorites()
    if (needle) {
      return props
        .groups()
        .flatMap((group) => group.models.map((model) => ({ model, section: group.title })))
        .flatMap((item) => {
          const score = pickerScore(needle, pickerSearchText(item, props.providerName))
          if (score === undefined) return []
          return [
            { kind: "model" as const, ...item, favorite: favorites.has(pickerKey(item.model)), score: score * 2 },
          ]
        })
        .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.score - a.score)
        .map(({ score: _score, ...row }) => row)
    }
    return props.groups().flatMap((group) => [
      ...(group.models.length > 0 ? [{ kind: "header" as const, title: group.title }] : []),
      ...group.models.map((model) => ({
        kind: "model" as const,
        model,
        section: group.title,
        favorite: favorites.has(pickerKey(model)),
      })),
    ])
  })

  type ModelRow = Extract<PickerRow, { kind: "model" }>
  const picks = createMemo(() => rows().filter((row): row is ModelRow => row.kind === "model"))
  const activeIndex = createMemo(() => {
    const key = selected()
    const index = key ? picks().findIndex((row) => pickerKey(row.model) === key) : -1
    return index >= 0 ? index : 0
  })
  const activeKey = createMemo(() => {
    const row = picks()[activeIndex()]
    return row ? pickerKey(row.model) : undefined
  })
  const activeRowIndex = createMemo(() => {
    const row = picks()[activeIndex()]
    return row ? rows().indexOf(row) : -1
  })

  // A query or a favorite toggle can drop the selected model from the list.
  createEffect(() => {
    const list = picks()
    if (list.length === 0) return
    const key = selected()
    if (key && list.some((row) => pickerKey(row.model) === key)) return
    setSelected(pickerKey(list[0].model))
  })

  function move(delta: number) {
    const list = picks()
    if (list.length === 0) return
    setSelected(pickerKey(list[(activeIndex() + delta + list.length) % list.length].model))
  }
  function choose() {
    const row = picks()[activeIndex()]
    if (row) props.onSelect(row.model)
  }
  function favorite() {
    const row = picks()[activeIndex()]
    if (row) props.onFavorite(row.model)
  }

  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { bind: "up,ctrl+p", run: () => move(-1) },
      { bind: "down,ctrl+n", run: () => move(1) },
      { bind: "pageup", run: () => move(-10) },
      { bind: "pagedown", run: () => move(10) },
      {
        bind: "home",
        run: () => {
          const list = picks()
          if (list.length > 0) setSelected(pickerKey(list[0].model))
        },
      },
      {
        bind: "end",
        run: () => {
          const list = picks()
          if (list.length > 0) setSelected(pickerKey(list[list.length - 1].model))
        },
      },
      { bind: "return", run: choose },
      { bind: "ctrl+f", run: favorite },
    ],
  }))

  /** Rows the dialog can show; the native picker caps at half the terminal. */
  const limit = createMemo(() => Math.max(4, Math.floor(dimensions().height / 2) - 6))
  const visible = createMemo(() => {
    const list = rows()
    const max = limit()
    if (list.length <= max) return { rows: list, offset: 0 }
    const start = Math.min(Math.max(0, activeRowIndex() - Math.floor(max / 2)), list.length - max)
    return { rows: list.slice(start, start + max), offset: start }
  })

  const textColor = (active: boolean) => (active ? theme.text.action.primary.focused : theme.text.base)
  const secondaryColor = (active: boolean) => (active ? theme.text.action.primary.focused : theme.text.muted)

  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="column">
        <box flexDirection="row" justifyContent="space-between" gap={2} paddingLeft={1}>
          <text fg={theme.text.base}>
            <b>{props.title}</b>
          </text>
          <text fg={theme.text.muted} onMouseUp={() => props.onClose()}>
            esc
          </text>
        </box>
        <box paddingTop={1} paddingLeft={1}>
          <input
            flexGrow={1}
            onInput={(value) => {
              setQuery(value)
              setSelected(undefined)
            }}
            focusedBackgroundColor={theme.background.formfield.focused}
            focusedTextColor={theme.text.formfield.focused}
            cursorColor={theme.text.base}
            placeholder="Search"
            placeholderColor={theme.text.muted}
            ref={(renderable) => {
              setTimeout(() => {
                if (!renderable.isDestroyed) renderable.focus()
              }, 1)
            }}
          />
        </box>
      </box>
      <Show
        when={rows().length > 0}
        fallback={
          <text fg={theme.text.muted}>{query().trim() ? "No results found" : "No items available"}</text>
        }
      >
        <box flexDirection="column">
          <For each={visible().rows}>
            {(row, index) => {
              if (row.kind === "header") {
                return (
                  <box paddingTop={index() === 0 ? 0 : 1} paddingLeft={1}>
                    <text fg={accent}>
                      <b>{row.title}</b>
                    </text>
                  </box>
                )
              }
              const active = () => activeKey() === pickerKey(row.model)
              const current = () => Boolean(props.current) && pickerKey(props.current!) === pickerKey(row.model)
              return (
                <box
                  flexDirection="row"
                  marginLeft={-1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.background.action.primary.focused : undefined}
                  onMouseMove={() => setSelected(pickerKey(row.model))}
                  onMouseDown={() => setSelected(pickerKey(row.model))}
                  onMouseUp={() => props.onSelect(row.model)}
                >
                  {/* The marker keeps its own cells so titles line up with unmarked rows, as in DialogSelect. */}
                  <text width={2} flexShrink={0} fg={active() ? textColor(active()) : theme.text.formfield.selected}>
                    {current() ? "● " : "  "}
                  </text>
                  <text flexGrow={1} wrapMode="none" overflow="hidden" fg={textColor(active())}>
                    {active() ? <b>{row.model.name || row.model.id}</b> : row.model.name || row.model.id}
                    <span style={{ fg: secondaryColor(active()) }}>
                      {" " + props.providerName(row.model.providerID)}
                    </span>
                  </text>
                  <Show when={row.favorite || isFreeModel(row.model)}>
                    <text fg={secondaryColor(active())}>{row.favorite ? "*" : "Free"}</text>
                  </Show>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
      <box flexDirection="row" justifyContent="space-between" gap={2} paddingLeft={1}>
        <text fg={theme.text.muted}>
          {"Favorite "}
          <span style={{ fg: theme.text.base }}>ctrl+f</span>
        </text>
      </box>
    </box>
  )
}
