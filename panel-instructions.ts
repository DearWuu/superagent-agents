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
  LEGACY_ASSIGNMENT_PROMPTS,
  LEGACY_SESSION_PROMPTS,
  LEGACY_TASK_PROMPTS,
  SUPERAGENT_DEFAULTS,
} from "./panel-defaults"
import { MODEL_POLICY_METADATA_KEY, writeChildModelPolicy } from "./model-policy"
import type { ModelInfo } from "./panel-types"
import type { RootSettings } from "./session-scope"

type InstructionState = { rootID?: string; values: Record<string, unknown> }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** `providerID/modelID[#variant]`，与模型条目同一写法。 */
function entryText(model: { providerID: string; id: string; variant?: string }) {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

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

  async function loadInstructions(sessionID = rootSessionID()) {
    if (!sessionID) return
    const entries = await context.client.experimental.session.instructions.entry.list({ sessionID })
    // A slow response for a root the user already left must not overwrite the current root.
    if (rootSessionID() !== sessionID) return
    setInstructions({ rootID: sessionID, values: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])) })
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
  async function removeSessionInstruction(sessionID: string, key: string) {
    await context.client.experimental.session.instructions.entry.remove({
      sessionID,
      key,
    })
    setInstructions((current) => {
      if (current.rootID !== sessionID) return current
      const values = { ...current.values }
      delete values[key]
      return { rootID: sessionID, values }
    })
  }
  async function putInstruction(key: string, value: string | number, sessionID = rootSessionID()) {
    if (!sessionID) return
    await putSessionInstruction(sessionID, key, value)
  }
  async function removeInstruction(key: string, sessionID = rootSessionID()) {
    if (!sessionID) return
    await removeSessionInstruction(sessionID, key)
  }
  async function saveInstructionText(key: string, value: string) {
    const text = value.trim()
    if (!text) return removeInstruction(key)
    return putInstruction(key, text)
  }

  /**
   * 初始化当前 root 的条目。指令条目读取失败时做一次有界重试，仍失败就按本地
   * 设置继续；ready 由 finally 保证置真，避免一次瞬时失败让面板永久停摆。
   * 全程使用捕获的 root id：await 期间用户切走 root 就停止后续写入，也不标记
   * 已初始化，避免把默认条目写进别的 root。
   */
  async function initializeInstructions() {
    setReady(false)
    const id = rootSessionID()
    if (!id) return
    const stale = () => rootSessionID() !== id
    try {
      let loaded = false
      for (let attempt = 0; attempt < 3 && !loaded; attempt += 1) {
        try {
          await loadInstructions(id)
          loaded = true
        } catch {
          if (attempt === 2) {
            context.ui.toast.show({ message: "指令条目加载失败，已按本地设置继续" })
          } else {
            await sleep(400)
          }
        }
      }
      if (stale()) return
      // 停用状态只加载开关本身，不初始化/补写其他条目，也不写回开关。
      if (!collabOn()) return
      mergeKeptEntry()
      await ensureFallbackDefaults(id)
      if (stale()) return
      await migrateDefaultInstructions(id)
      if (stale()) return
      await ensureDefaultPolicyEntry(id)
      if (stale()) return
      if (!root().initialized[id]) {
        for (const [key, value] of defaultInstructionEntries()) {
          if (instructionValue(key) !== undefined) continue
          await putInstruction(key, value, id)
          if (stale()) return
        }
        await updateRoot((draft) => {
          draft.initialized = { ...draft.initialized, [id]: true }
        })
      }
    } finally {
      setReady(true)
    }
  }

  /**
   * Backfills the fallback/critic keys for roots initialized before they existed.
   * 限额条目只在配置了备用模型时存在：没有任何备用模型就移除它们，避免面板
   * 显示一个不存在的限额切换配置。
   */
  async function ensureFallbackDefaults(sessionID: string) {
    const hasFallback =
      instructionPresent(INSTRUCTION_KEYS.fallbackModel) ||
      instructionPresent(INSTRUCTION_KEYS.subagentFallbackModel)
    if (hasFallback) {
      if (instructionValue(INSTRUCTION_KEYS.fallbackThreshold) === undefined) {
        await putInstruction(INSTRUCTION_KEYS.fallbackThreshold, SUPERAGENT_DEFAULTS.fallbackThreshold, sessionID)
      }
      if (instructionValue(INSTRUCTION_KEYS.fallbackEnabled) === undefined) {
        await putInstruction(
          INSTRUCTION_KEYS.fallbackEnabled,
          String(SUPERAGENT_DEFAULTS.fallbackEnabled),
          sessionID,
        )
      }
    } else {
      for (const key of [INSTRUCTION_KEYS.fallbackThreshold, INSTRUCTION_KEYS.fallbackEnabled]) {
        if (instructionValue(key) !== undefined) await removeInstruction(key, sessionID)
      }
    }
    const keys = new Set<string>([
      INSTRUCTION_KEYS.criticEnabled,
      INSTRUCTION_KEYS.statusWatch,
      INSTRUCTION_KEYS.maxFlagshipSubagents,
      INSTRUCTION_KEYS.oversightLevel,
    ])
    for (const [key, value] of defaultInstructionEntries()) {
      if (!keys.has(key) || instructionValue(key) !== undefined) continue
      await putInstruction(key, value, sessionID)
    }
  }

  /** 面板刚配置了备用模型：确保限额切换的两项存在（缺才写）。 */
  async function ensureFallbackQuotaDefaults() {
    const id = rootSessionID()
    if (!id) return
    if (
      !instructionPresent(INSTRUCTION_KEYS.fallbackModel) &&
      !instructionPresent(INSTRUCTION_KEYS.subagentFallbackModel)
    ) {
      return
    }
    if (instructionValue(INSTRUCTION_KEYS.fallbackThreshold) === undefined) {
      await putInstruction(INSTRUCTION_KEYS.fallbackThreshold, SUPERAGENT_DEFAULTS.fallbackThreshold, id)
    }
    if (instructionValue(INSTRUCTION_KEYS.fallbackEnabled) === undefined) {
      await putInstruction(INSTRUCTION_KEYS.fallbackEnabled, String(SUPERAGENT_DEFAULTS.fallbackEnabled), id)
    }
  }

  /**
   * Prompt defaults changed: assignment, session and task text that is absent
   * or still exactly a previous default moves to the new text. A user's custom
   * text is untouched; assignment lives on the root, the other two are entries.
   */
  async function migrateDefaultInstructions(sessionID: string) {
    const session = instructionText(INSTRUCTION_KEYS.sessionPrompt)
    if (!instructionPresent(INSTRUCTION_KEYS.sessionPrompt) || LEGACY_SESSION_PROMPTS.includes(session)) {
      await putInstruction(INSTRUCTION_KEYS.sessionPrompt, SUPERAGENT_DEFAULTS.sessionPrompt, sessionID)
    }
    const assignment = root().assignmentPrompt
    if (!assignment.trim() || LEGACY_ASSIGNMENT_PROMPTS.includes(assignment)) {
      await updateRoot((draft) => {
        draft.assignmentPrompt = SUPERAGENT_DEFAULTS.assignmentPrompt
      })
    }
    const task = instructionText(INSTRUCTION_KEYS.taskPrompt)
    if (!instructionPresent(INSTRUCTION_KEYS.taskPrompt) || LEGACY_TASK_PROMPTS.includes(task)) {
      await putInstruction(INSTRUCTION_KEYS.taskPrompt, SUPERAGENT_DEFAULTS.taskPrompt, sessionID)
    }
  }

  /**
   * 面板初始化时对账 root 的默认模型策略：策略条目缺失时补写本地策略，
   * fixed 的模型条目与本地目标对齐，非 fixed 移除模型条目；每个子代理的
   * 策略元数据缺失时 best-effort 补写，供服务端派工时读取。
   */
  async function ensureDefaultPolicyEntry(sessionID: string) {
    const scoped = root()
    const policy = scoped.defaultPolicy ?? "inherit"
    if (instructionValue(INSTRUCTION_KEYS.defaultPolicy) === undefined) {
      await putInstruction(INSTRUCTION_KEYS.defaultPolicy, policy, sessionID)
    }
    if (rootSessionID() !== sessionID) return
    const model = scoped.defaultModel
    if (policy === "fixed" && model) {
      const expected = entryText(model)
      if (instructionText(INSTRUCTION_KEYS.defaultModel) !== expected) {
        await putInstruction(INSTRUCTION_KEYS.defaultModel, expected, sessionID)
      }
    } else if (instructionPresent(INSTRUCTION_KEYS.defaultModel)) {
      await removeInstruction(INSTRUCTION_KEYS.defaultModel, sessionID)
    }
    if (rootSessionID() !== sessionID) return
    for (const [childID, childPolicy] of Object.entries(scoped.policies ?? {})) {
      const child = context.data.session.get(childID)
      if (!child) continue
      if (child.metadata?.[MODEL_POLICY_METADATA_KEY] !== undefined) continue
      await writeChildModelPolicy(context, childID, childPolicy)
      if (rootSessionID() !== sessionID) return
    }
  }

  async function restoreDefaults() {
    const id = rootSessionID()
    const entries = defaultInstructionEntries()
    for (const [key, value] of entries) await putInstruction(key, value, id)
    for (const key of [
      INSTRUCTION_KEYS.fallbackModel,
      INSTRUCTION_KEYS.subagentFallbackModel,
      INSTRUCTION_KEYS.fallbackThreshold,
      INSTRUCTION_KEYS.fallbackEnabled,
      INSTRUCTION_KEYS.defaultModel,
    ]) {
      if (!entries.some(([entryKey]) => entryKey === key)) await removeInstruction(key, id)
    }
    await putInstruction(INSTRUCTION_KEYS.defaultPolicy, SUPERAGENT_DEFAULTS.defaultPolicy, id)
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
      [INSTRUCTION_KEYS.criticEnabled, String(SUPERAGENT_DEFAULTS.criticEnabled)],
      [INSTRUCTION_KEYS.statusWatch, String(SUPERAGENT_DEFAULTS.statusWatch)],
    ]
    for (const [key, model] of [
      [INSTRUCTION_KEYS.fallbackModel, SUPERAGENT_DEFAULTS.fallbackModel],
      [INSTRUCTION_KEYS.subagentFallbackModel, SUPERAGENT_DEFAULTS.subagentFallbackModel],
      [INSTRUCTION_KEYS.defaultModel, SUPERAGENT_DEFAULTS.defaultModel],
    ] as const) {
      if (!model) continue
      if (models().some((item) => item.providerID === model.providerID && item.id === model.id))
        entries.push([key, entryText(model)])
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
    ensureFallbackQuotaDefaults,
    writeKeptEntry,
  }
}