/**
 * TUI 面板的会话指令读写：加载 root 的指令条目、初始化/迁移默认值、恢复默认、
 * 维护保护名单对应的 kept 条目。
 *
 * 依赖由 SidebarAgents 以访问器注入；本模块不持有状态，也不创建 effect。
 */

import type { Plugin } from "@opencode/plugin/tui"
import type { Setter } from "solid-js"
import {
  INSTRUCTION_KEYS,
  LEGACY_SESSION_PROMPTS,
  LEGACY_TASK_PROMPT,
  SUPERAGENT_DEFAULTS,
} from "./panel-defaults"
import type { ModelInfo } from "./panel-types"
import type { RootSettings } from "./session-scope"

type InstructionState = { rootID?: string; values: Record<string, unknown> }

export function createInstructionActions(deps: {
  context: Plugin.Context
  rootSessionID: () => string | undefined
  collabOn: () => boolean
  root: () => RootSettings
  models: () => ModelInfo[]
  instructionValue: (key: string) => unknown
  instructionText: (key: string) => string
  instructionPresent: (key: string) => boolean
  updateRoot: (mutation: (draft: RootSettings) => void) => unknown
  updateGlobal: (mutation: (draft: Record<string, any>) => void) => unknown
  setInstructions: Setter<InstructionState>
  setReady: Setter<boolean>
}) {
  const {
    context,
    rootSessionID,
    collabOn,
    root,
    models,
    instructionValue,
    instructionText,
    instructionPresent,
    updateRoot,
    updateGlobal,
    setInstructions,
    setReady,
  } = deps

  async function loadInstructions() {
    const id = rootSessionID()
    if (!id) return
    const entries = await context.client.experimental.session.instructions.entry.list({ sessionID: id })
    // A slow response for a root the user already left must not overwrite the current root.
    if (rootSessionID() !== id) return
    setInstructions({ rootID: id, values: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])) })
  }
  async function putInstruction(key: string, value: string | number) {
    const id = rootSessionID()
    if (!id) return
    await putSessionInstruction(id, key, value)
  }
  async function putSessionInstruction(sessionID: string, key: string, value: string | number) {
    await context.client.experimental.session.instructions.entry.put({
      sessionID,
      key,
      value,
    })
    if (sessionID !== rootSessionID()) return
    setInstructions((current) => ({
      rootID: sessionID,
      values: { ...(current.rootID === sessionID ? current.values : {}), [key]: value },
    }))
  }
  async function removeInstruction(key: string) {
    const id = rootSessionID()
    if (!id) return
    await context.client.experimental.session.instructions.entry.remove({
      sessionID: id,
      key,
    })
    setInstructions((current) => {
      if (current.rootID !== id) return current
      const values = { ...current.values }
      delete values[key]
      return { rootID: id, values }
    })
  }
  async function saveInstructionText(key: string, value: string) {
    const text = value.trim()
    if (!text) return removeInstruction(key)
    return putInstruction(key, text)
  }
  async function initializeInstructions() {
    setReady(false)
    await loadInstructions()
    const id = rootSessionID()
    if (!id) return
    // 停用状态只加载开关本身，不初始化/补写其他条目，也不写回开关。
    if (!collabOn()) {
      setReady(true)
      return
    }
    mergeKeptEntry()
    await ensureFallbackDefaults()
    await migrateDefaultInstructions()
    if (!root().initialized[id]) {
      for (const [key, value] of defaultInstructionEntries()) {
        if (instructionValue(key) !== undefined) continue
        await putInstruction(key, value)
      }
      await updateRoot((draft) => {
        draft.initialized = { ...draft.initialized, [id]: true }
      })
    }
    setReady(true)
  }

  /** Backfills the fallback/critic keys for roots initialized before they existed. */
  async function ensureFallbackDefaults() {
    const keys = new Set<string>([
      INSTRUCTION_KEYS.fallbackModel,
      INSTRUCTION_KEYS.subagentFallbackModel,
      INSTRUCTION_KEYS.fallbackThreshold,
      INSTRUCTION_KEYS.fallbackEnabled,
      INSTRUCTION_KEYS.criticEnabled,
      INSTRUCTION_KEYS.maxFlagshipSubagents,
      INSTRUCTION_KEYS.oversightLevel,
    ])
    for (const [key, value] of defaultInstructionEntries()) {
      if (!keys.has(key) || instructionValue(key) !== undefined) continue
      await putInstruction(key, value)
    }
  }
  /**
   * Prompt defaults changed: entries that are absent or still exactly the
   * previous default move to the new text. A user's custom text is untouched.
   */
  async function migrateDefaultInstructions() {
    const session = instructionText(INSTRUCTION_KEYS.sessionPrompt)
    if (!instructionPresent(INSTRUCTION_KEYS.sessionPrompt) || LEGACY_SESSION_PROMPTS.includes(session)) {
      await putInstruction(INSTRUCTION_KEYS.sessionPrompt, SUPERAGENT_DEFAULTS.sessionPrompt)
    }
    const task = instructionText(INSTRUCTION_KEYS.taskPrompt)
    if (!instructionPresent(INSTRUCTION_KEYS.taskPrompt) || task === LEGACY_TASK_PROMPT) {
      await putInstruction(INSTRUCTION_KEYS.taskPrompt, SUPERAGENT_DEFAULTS.taskPrompt)
    }
  }

  async function restoreDefaults() {
    const entries = defaultInstructionEntries()
    for (const [key, value] of entries) await putInstruction(key, value)
    for (const key of [
      INSTRUCTION_KEYS.fallbackModel,
      INSTRUCTION_KEYS.subagentFallbackModel,
      INSTRUCTION_KEYS.defaultModel,
    ]) {
      if (!entries.some(([entryKey]) => entryKey === key)) await removeInstruction(key)
    }
    await updateRoot((draft) => {
      draft.defaultPolicy = SUPERAGENT_DEFAULTS.defaultPolicy
      draft.defaultModel = SUPERAGENT_DEFAULTS.defaultModel
      draft.defaultSetAt = Date.now()
      draft.assignmentPrompt = ""
    })
    await updateGlobal((draft) => {
      draft.autoModels = [...SUPERAGENT_DEFAULTS.autoModels]
    })
    context.ui.toast.show({ message: "已恢复默认编排策略。" })
  }

  /** Entry defaults for this root; optional models only when the catalog has them. */
  function defaultInstructionEntries(): Array<[string, string | number]> {
    const entries: Array<[string, string | number]> = [
      [INSTRUCTION_KEYS.reportStyle, SUPERAGENT_DEFAULTS.reportStyle],
      [INSTRUCTION_KEYS.maxSubagents, SUPERAGENT_DEFAULTS.maxSubagents],
      [INSTRUCTION_KEYS.maxFlagshipSubagents, SUPERAGENT_DEFAULTS.maxFlagshipSubagents],
      [INSTRUCTION_KEYS.sessionPrompt, SUPERAGENT_DEFAULTS.sessionPrompt],
      [INSTRUCTION_KEYS.taskPrompt, SUPERAGENT_DEFAULTS.taskPrompt],
      [INSTRUCTION_KEYS.fallbackThreshold, SUPERAGENT_DEFAULTS.fallbackThreshold],
      [INSTRUCTION_KEYS.fallbackEnabled, String(SUPERAGENT_DEFAULTS.fallbackEnabled)],
      [INSTRUCTION_KEYS.criticEnabled, String(SUPERAGENT_DEFAULTS.criticEnabled)],
    ]
    for (const [key, model] of [
      [INSTRUCTION_KEYS.fallbackModel, SUPERAGENT_DEFAULTS.fallbackModel],
      [INSTRUCTION_KEYS.subagentFallbackModel, SUPERAGENT_DEFAULTS.subagentFallbackModel],
      [INSTRUCTION_KEYS.defaultModel, SUPERAGENT_DEFAULTS.defaultModel],
    ] as const) {
      if (!model) continue
      if (models().some((item) => item.providerID === model.providerID && item.id === model.id))
        entries.push([key, `${model.providerID}/${model.id}`])
    }
    return entries
  }

  /** The entry is the source of truth for eviction; merge what it holds on load. */
  function mergeKeptEntry() {
    const kept = instructionText(INSTRUCTION_KEYS.keptSubagents)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
    if (kept.length === 0) return
    void updateRoot((draft) => {
      draft.keptSubagents = {
        ...Object.fromEntries(kept.map((id) => [id, true])),
        ...draft.keptSubagents,
      }
    })
  }

  /** Writes the root scope's protection list for the server-side eviction guard. */
  async function writeKeptEntry(kept: Record<string, boolean>) {
    const ids = Object.keys(kept).filter((id) => kept[id])
    if (ids.length === 0) return removeInstruction(INSTRUCTION_KEYS.keptSubagents)
    return putInstruction(INSTRUCTION_KEYS.keptSubagents, ids.join(","))
  }

  return {
    loadInstructions,
    putInstruction,
    putSessionInstruction,
    removeInstruction,
    saveInstructionText,
    initializeInstructions,
    restoreDefaults,
    writeKeptEntry,
  }
}
