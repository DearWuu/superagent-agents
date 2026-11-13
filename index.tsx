/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { Plugin as PluginDef } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import {
  buildAgentTree,
  flattenAgentTree,
  type AgentNode,
  type FlatNode,
} from "./agent-tree"
import { modelKey, sameModel, type ModelRef } from "./model-policy"
import {
  OVERSIGHT_LEVEL_NAMES,
  oversightLabel,
  oversightLevelForPin,
  renderReportProtocol,
  resolveOversight,
  type OversightContract,
  type OversightLevel,
} from "./oversight"
import {
  SETTINGS_VERSION,
  formatSubagentCounter,
  isLegacySettings,
  migrateLegacySettings,
  readRootSettings,
  scopedRootDraft,
  type RootSettings,
  type ScopedSettings,
} from "./session-scope"
import { sessionRunning } from "./run-duration"
import { migrateLegacyPluginStorage, storageDirectory } from "./storage-migration"
import {
  DEFAULT_MAX_FLAGSHIP_SUBAGENTS,
  countFlagshipSubagents,
  effectiveFlagshipLimit,
} from "./flagship"
import { isExplicitModelDelegation } from "./model-delegation"
import { pickerKey, type PickerGroup } from "./model-picker"
import { AgentPanelView } from "./panel-view"
import { createInstructionActions } from "./panel-instructions"
import { createModelActions } from "./panel-model-actions"
import { createManualNotifier, type ManualOpAction, type ManualOpDetail } from "./panel-notify"
import { createRowHelpers } from "./panel-rows"
import { createEvictionActions } from "./panel-eviction"
import {
  INSTRUCTION_KEYS,
  OVERSIGHT_LEVEL_DESCRIPTIONS,
  SUPERAGENT_DEFAULTS,
  collabEnabledFromInstructions,
  normalizeReportStyle,
  reportStyleLabel,
  summarize,
} from "./panel-defaults"
import {
  appendOversightEvent,
  criticDirectory,
  criticView,
  readCriticRecords,
  recentOversightEvents,
  type CriticRecord,
} from "./panel-critic"
import {
  defaultModelPreferencePath,
  readModelPreference,
  recentModels,
  updateModelPreference,
  type ModelPreference,
  type PreferenceModel,
} from "./panel-preferences"
import type {
  AgentAction,
  FallbackAction,
  ModelInfo,
  OversightAction,
  PolicyAction,
  ProviderInfo,
  SettingsAction,
} from "./panel-types"
import {
  DEFAULT_CONTENT_WIDTH,
  MIN_CONTENT_WIDTH,
  SEPARATOR,
  decorate,
  errorText,
  headerLine,
  isFreeGroupModel,
  isSessionRunning,
  subagentTitle,
  toSessionInput,
  truncate,
  withTimestampedFallback,
} from "./panel-utils"

export { OVERSIGHT_LEVEL_DESCRIPTIONS, SUPERAGENT_DEFAULTS, collabEnabledFromInstructions } from "./panel-defaults"
export { CONTEXT_WARN_TOKENS, contextTokens, contextUsageView, formatTokenCount } from "./panel-context"
export type { SessionTokenUsage } from "./panel-context"
export { ModelPicker } from "./model-picker"
export type { PickerGroup } from "./model-picker"

export function SidebarAgents(props: {
  context: Plugin.Context
  sessionID: string
  preferencePath?: string
  criticDir?: string
}) {
  const theme = props.context.theme
  const [settings, updateSettings] = props.context.storage.store<ScopedSettings>(STORAGE_KEY, {
    initial: {
      version: SETTINGS_VERSION,
      autoModels: [...SUPERAGENT_DEFAULTS.autoModels],
      roots: {},
    },
  })
  const preferencePath = props.preferencePath ?? defaultModelPreferencePath()
  const [preferences, setPreferences] = createSignal<ModelPreference>({ recent: [], favorite: [], variant: {} })
  async function loadPreferences() {
    setPreferences((await readModelPreference(preferencePath)).preference)
  }
  createEffect(() => {
    void loadPreferences()
  })
  async function rememberRecent(model: ModelInfo) {
    setPreferences(
      await updateModelPreference(preferencePath, (current) => ({
        recent: recentModels({ providerID: model.providerID, modelID: model.id }, current.recent),
      })),
    )
  }

  /**
   * This root's instruction entries. The root id is stored with the values so a
   * root switch never shows the previous root's switch state while the new
   * entries are still loading.
   */
  const [instructions, setInstructions] = createSignal<{ rootID?: string; values: Record<string, unknown> }>({
    values: {},
  })
  /** True once this root's instructions (and thus its cap) are loaded. */
  const [ready, setReady] = createSignal(false)

  /** The family root of the session the user is looking at. */
  const rootSessionID = createMemo(() => props.context.data.session.root(props.sessionID))
  const instructionValue = (key: string) => {
    const state = instructions()
    return state.rootID === rootSessionID() ? state.values[key] : undefined
  }
  const instructionText = (key: string) => {
    const value = instructionValue(key)
    return typeof value === "string" ? value : typeof value === "number" ? String(value) : ""
  }
  const instructionPresent = (key: string) => {
    const value = instructionValue(key)
    return value !== undefined && value !== null && String(value).trim() !== ""
  }
  /** Only this root's entry controls its switch; other roots are independent. */
  const collabOn = createMemo(() =>
    collabEnabledFromInstructions(instructions().rootID === rootSessionID() ? instructions().values : {}),
  )

  /** The settings of that root; every root keeps its own copy. */
  const root = createMemo(() => readRootSettings(settings, rootSessionID()))
  /** The global model list, shared by every root. */
  const autoModels = createMemo(() => (Array.isArray(settings.autoModels) ? settings.autoModels : []))

  const policy = createMemo(() => {
    const style = normalizeReportStyle(
      instructionText(INSTRUCTION_KEYS.reportStyle) || SUPERAGENT_DEFAULTS.reportStyle,
    )
    return {
      reportStyle: style,
      reportStyleCustom:
        instructionPresent(INSTRUCTION_KEYS.reportStyle) &&
        instructionText(INSTRUCTION_KEYS.reportStyle) !== SUPERAGENT_DEFAULTS.reportStyle,
      sessionPrompt: instructionText(INSTRUCTION_KEYS.sessionPrompt) || SUPERAGENT_DEFAULTS.sessionPrompt,
      sessionPromptCustom:
        instructionPresent(INSTRUCTION_KEYS.sessionPrompt) &&
        instructionText(INSTRUCTION_KEYS.sessionPrompt) !== SUPERAGENT_DEFAULTS.sessionPrompt,
      taskPrompt: instructionText(INSTRUCTION_KEYS.taskPrompt),
      taskPromptCustom: instructionPresent(INSTRUCTION_KEYS.taskPrompt),
      maxSubagents: instructionText(INSTRUCTION_KEYS.maxSubagents) || String(SUPERAGENT_DEFAULTS.maxSubagents),
      maxSubagentsCustom:
        instructionPresent(INSTRUCTION_KEYS.maxSubagents) &&
        instructionText(INSTRUCTION_KEYS.maxSubagents) !== String(SUPERAGENT_DEFAULTS.maxSubagents),
      maxFlagshipSubagents:
        instructionText(INSTRUCTION_KEYS.maxFlagshipSubagents) ||
        String(SUPERAGENT_DEFAULTS.maxFlagshipSubagents),
      maxFlagshipSubagentsCustom:
        instructionPresent(INSTRUCTION_KEYS.maxFlagshipSubagents) &&
        instructionText(INSTRUCTION_KEYS.maxFlagshipSubagents) !==
          String(SUPERAGENT_DEFAULTS.maxFlagshipSubagents),
      assignmentPrompt: root().assignmentPrompt || SUPERAGENT_DEFAULTS.assignmentPrompt,
      assignmentPromptCustom: root().assignmentPrompt !== "" && root().assignmentPrompt !== SUPERAGENT_DEFAULTS.assignmentPrompt,
    }
  })

  const session = createMemo(() => props.context.data.session.get(rootSessionID()))
  const sessions = createMemo(() =>
    props.context.data.session.list().filter((item) => item.time?.archived === undefined),
  )
  /** 子会话消息不会随列表自动加载；每个子代理同步一次，失败允许下一轮重试。 */
  const messageSyncPending = new Set<string>()
  createEffect(() => {
    const rootID = rootSessionID()
    if (!rootID || !collabOn()) return
    const family = new Set(props.context.data.session.family(rootID))
    for (const item of sessions()) {
      if (item.id === rootID || !family.has(item.id) || messageSyncPending.has(item.id)) continue
      const sync = props.context.data.session.message.sync
      if (typeof sync !== "function") continue
      messageSyncPending.add(item.id)
      void sync(item.id).catch(() => {
        messageSyncPending.delete(item.id)
      })
    }
  })
  /** The direct, non-archived children of the family root. */
  const directSubagents = createMemo(() => {
    const family = new Set(props.context.data.session.family(rootSessionID()))
    return sessions().filter((item) => item.parentID === rootSessionID() && family.has(item.id))
  })
  /** How many of those children are running right now. */
  const runningSubagents = createMemo(
    () =>
      directSubagents().filter((item) => sessionRunning(isSessionRunning(props.context, item.id))).length,
  )
  /** The maximum number of Subagents this root may hold at the same time. */
  const subagentLimit = createMemo(() => {
    const instructed = Number(policy().maxSubagents)
    if (Number.isInteger(instructed) && instructed >= 1 && instructed <= 20) return instructed
    const scoped = root().maxSubagents
    if (typeof scoped === "number" && scoped >= 1 && scoped <= 20) return scoped
    return SUPERAGENT_DEFAULTS.maxSubagents
  })
  const subagentOverLimit = createMemo(() => directSubagents().length > subagentLimit())
  const subagentCountText = createMemo(() =>
    headerLine(
      "子代理",
      formatSubagentCounter({
        existing: directSubagents().length,
        limit: subagentLimit(),
        running: runningSubagents(),
      }),
    ),
  )

  // A legacy document holds one flat set of settings. It is migrated into the
  // root that is open right now, once, so it never leaks into another root.
  const migrationOwner: { current?: string } = {}
  createEffect(() => {
    if (!isLegacySettings(settings)) return
    const id = rootSessionID()
    if (!id) return
    if (!migrationOwner.current) migrationOwner.current = id
    const owner = migrationOwner.current
    // A flat document may already carry protections; scoping must keep them.
    const legacyKept = (settings as Record<string, unknown>).keptSubagents
    void updateSettings((draft: Record<string, any>) => {
      const migrated = migrateLegacySettings(draft, owner)
      if (legacyKept && typeof legacyKept === "object")
        migrated.roots[owner].keptSubagents = {
          ...(legacyKept as Record<string, boolean>),
          ...migrated.roots[owner].keptSubagents,
        }
      for (const key of Object.keys(draft)) delete draft[key]
      Object.assign(draft, migrated)
    })
  })

  /** Changes the scoped settings of the current root. */
  const updateRoot = (mutation: (draft: RootSettings) => void) =>
    updateSettings((draft: Record<string, any>) => {
      mutation(scopedRootDraft(draft, rootSessionID(), migrationOwner.current))
    })
  /** Changes the global part of the document. */
  const updateGlobal = (mutation: (draft: Record<string, any>) => void) =>
    updateSettings((draft: Record<string, any>) => {
      scopedRootDraft(draft, rootSessionID(), migrationOwner.current)
      mutation(draft)
    })

  const models = createMemo(() =>
    ((props.context.data.location.model.list(session()?.location) ?? []) as ModelInfo[]).filter(
      (model) => model.status !== "deprecated",
    ),
  )
  const {
    loadInstructions,
    putInstruction,
    putSessionInstruction,
    removeInstruction,
    saveInstructionText,
    initializeInstructions,
    restoreDefaults,
    writeKeptEntry,
  } = createInstructionActions({
    context: props.context,
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
  })

  createEffect(() => {
    const id = rootSessionID()
    if (!id) return
    // 停用时不为会话初始化/补写指令条目；重新开启后本 effect 会再跑。
    if (!collabOn()) return
    void initializeInstructions().catch(() => {})
  })

  const providerNames = createMemo(() => {
    const map = new Map<string, string>()
    for (const provider of (props.context.data.location.provider.list(session()?.location) ?? []) as ProviderInfo[])
      map.set(provider.id, provider.name)
    return map
  })
  const providerName = (providerID: string) => providerNames().get(providerID) ?? providerID
  const preferenceKey = (model: { providerID: string; id: string }) => `${model.providerID}/${model.id}`
  const modelFor = (item: PreferenceModel) =>
    models().find((model) => model.providerID === item.providerID && model.id === item.modelID)
  const favoritePickModels = () => preferences().favorite.flatMap((item) => modelFor(item) ?? [])
  const recentPickModels = () => {
    const favorite = new Set(favoritePickModels().map(preferenceKey))
    return preferences().recent.flatMap((item) => {
      const model = modelFor(item)
      return model && !favorite.has(preferenceKey(model)) ? [model] : []
    })
  }
  const listedModels = () => new Set([...favoritePickModels(), ...recentPickModels()].map(preferenceKey))
  const providerRank = (providerID: string) =>
    providerID === "opencode-go" ? 0 : providerID === "opencode" ? 1 : 2
  const byProvider = (a: ModelInfo, b: ModelInfo) =>
    providerRank(a.providerID) - providerRank(b.providerID) ||
    providerName(a.providerID).localeCompare(providerName(b.providerID))
  const modelChoice = (model: ModelInfo, category: string, favorite = false) => ({
    value: { kind: "model" as const, model },
    title: model.name || model.id,
    description: providerName(model.providerID),
    category,
    footer: favorite ? "*" : isFreeGroupModel(model) ? "Free" : undefined,
  })
  /** The bundled picker's sections: Favorites, Recent, each provider, then OpenCode's free models. */
  const pickerGroups = () => {
    const listed = listedModels()
    const remaining = models().filter((model) => !listed.has(preferenceKey(model)))
    const groups: PickerGroup[] = [
      { title: "Favorites", models: favoritePickModels() },
      { title: "Recent", models: recentPickModels() },
    ]
    for (const model of remaining.filter((item) => !isFreeGroupModel(item)).sort(byProvider)) {
      const title = providerName(model.providerID)
      const group = groups.find((item) => item.title === title)
      if (group) group.models.push(model)
      else groups.push({ title, models: [model] })
    }
    groups.push({ title: "Free", models: remaining.filter(isFreeGroupModel).sort(byProvider) })
    return groups
  }
  const pickerFavorites = () =>
    new Set(preferences().favorite.map((item) => `${item.providerID}/${item.modelID}`))
  const currentSelection = createMemo(() => {
    const selection = props.context.ui.model.current()
    return selection
      ? { providerID: selection.providerID, id: selection.modelID, variant: selection.variant }
      : undefined
  })

  const names = createMemo(() => {
    const map = new Map<string, string>()
    for (const model of models()) {
      map.set(modelKey(model), model.name || model.id)
      map.set(`${model.providerID}/${model.id}`, model.name || model.id)
    }
    for (const model of autoModels()) if (!map.has(modelKey(model))) map.set(modelKey(model), modelKey(model))
    return map
  })

  /** A `providerID/modelID` entry rendered with the catalog name when known. */
  const modelEntryLabel = (entryKey: string) => {
    const value = instructionText(entryKey)
    const slash = value.indexOf("/")
    if (slash <= 0) return value
    const providerID = value.slice(0, slash)
    const id = value.slice(slash + 1)
    return names().get(`${providerID}/${id}`) ?? names().get(modelKey({ providerID, id })) ?? id
  }
  const fallbackThreshold = createMemo(() => {
    const parsed = Number(instructionText(INSTRUCTION_KEYS.fallbackThreshold))
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10) return parsed
    return SUPERAGENT_DEFAULTS.fallbackThreshold
  })
  const fallbackEnabled = createMemo(() => {
    const value = instructionText(INSTRUCTION_KEYS.fallbackEnabled)
    if (!value) return SUPERAGENT_DEFAULTS.fallbackEnabled
    return value === "true" || value === "1"
  })
  const criticEnabled = createMemo(() => {
    const value = instructionText(INSTRUCTION_KEYS.criticEnabled)
    if (!value) return SUPERAGENT_DEFAULTS.criticEnabled
    return value === "true" || value === "1"
  })
  /** 子代理状态监测：只有明确的 false 才停用，其余按启用处理（与服务端口径一致）。 */
  const statusWatch = createMemo(() => {
    const value = instructionText(INSTRUCTION_KEYS.statusWatch).trim().toLowerCase()
    if (!value) return SUPERAGENT_DEFAULTS.statusWatch
    return value !== "false"
  })
  /** `GLM-5.3 · 连续3次失败切换 · 已启用`; `未设置` without a model. */
  const fallbackSummary = createMemo(() => {
    const label = modelEntryLabel(INSTRUCTION_KEYS.fallbackModel)
    const status = fallbackEnabled() ? "已启用" : "已停用"
    return `${label || "未设置"}${SEPARATOR}连续${fallbackThreshold()}次失败切换${SEPARATOR}${status}`
  })
  const subagentFallbackSummary = createMemo(() => {
    const label = modelEntryLabel(INSTRUCTION_KEYS.subagentFallbackModel)
    return `${label || "未设置"}${SEPARATOR}子代理限额时切换`
  })

  const criticDir = props.criticDir ?? criticDirectory()
  const [criticRecords, setCriticRecords] = createSignal<Map<string, CriticRecord>>(new Map())
  async function refreshCriticRecords() {
    setCriticRecords(await readCriticRecords(criticDir))
  }
  createEffect(() => {
    rootSessionID()
    sessions()
    void refreshCriticRecords()
  })
  const criticRecord = (sessionID: string | undefined) =>
    sessionID ? criticRecords().get(sessionID) : undefined
  const criticColor = (record: CriticRecord) =>
    criticView(record.verdict).warning ? (theme.text.feedback?.warning?.base ?? theme.text.muted) : theme.text.muted
  const criticIndent = (row: FlatNode) => " ".repeat(titleColumn(row))
  async function openCritic(node: AgentNode, record: CriticRecord) {
    const differences =
      record.differences.length > 0
        ? record.differences.map((item, index) => `${index + 1}. ${item}`).join("\n")
        : "无差异明细。"
    await props.context.ui.dialog.alert({
      title: `critic 复核 · ${node.title}`,
      message: `复核结论：${record.verdict}\n\n差异明细：\n${differences}`,
    })
  }

  const oversightFor = (sessionID = rootSessionID()): OversightContract =>
    resolveOversight({
      sessionID,
      rootSessionID: rootSessionID(),
      pins: root().oversight.pins,
    })
  const rootOversight = createMemo(() => oversightFor(rootSessionID()))

  /** The report protocol of this root, injected into the assignment prompt. */
  const reportProtocol = createMemo(() => renderReportProtocol(rootOversight()))
  const assignmentPromptEntry = createMemo(
    () => `${reportProtocol()}\n\n${root().assignmentPrompt || SUPERAGENT_DEFAULTS.assignmentPrompt}`,
  )

  async function writeOversightInstruction(contract: OversightContract) {
    const id = rootSessionID()
    if (!id) return
    const text = renderReportProtocol(contract)
    const level = String(contract.level)
    const textChanged = instructionText(INSTRUCTION_KEYS.oversight) !== text
    const levelChanged = instructionText(INSTRUCTION_KEYS.oversightLevel) !== level
    if (!textChanged && !levelChanged) return
    if (textChanged) await putInstruction(INSTRUCTION_KEYS.oversight, text)
    if (levelChanged) await putInstruction(INSTRUCTION_KEYS.oversightLevel, contract.level)
    await updateRoot((draft) => {
      draft.oversight.lastResolved = {
        ...draft.oversight.lastResolved,
        [id]: { level: contract.level, source: contract.source, at: Date.now() },
      }
    })
    void appendOversightEvent("oversight.computed", {
      rootSessionID: id,
      sessionID: id,
      oversight: { level: contract.level, source: contract.source },
    }).catch(() => {})
  }
  createEffect(() => {
    if (!ready()) return
    if (!collabOn()) return
    if (!session()) return
    void writeOversightInstruction(rootOversight()).catch(() => {})
  })

  /** The assignment prompt always starts with the report protocol. */
  createEffect(() => {
    const id = rootSessionID()
    if (!id) return
    if (!ready()) return
    if (!collabOn()) return
    if (!root().initialized[id]) return
    if (instructionText(INSTRUCTION_KEYS.assignmentPrompt) === assignmentPromptEntry()) return
    void putInstruction(INSTRUCTION_KEYS.assignmentPrompt, assignmentPromptEntry()).catch(() => {})
  })

  /**
   * Child sessions get their own machine-readable level and assignment prompt
   * so a running child sees acceptance changes on its next turn. Root changes
   * update unpinned children; a pinned child is written only when created or
   * when its own pin changes.
   */
  const oversightSynced = new Map<string, { level: number; pinned: boolean; assignment: string }>()
  let syncingOversight = false
  async function syncChildOversightEntries(
    rootID: string,
    desired: Array<{
      sessionID: string
      level: number
      pinned: boolean
      assignment: string
    }>,
  ) {
    if (syncingOversight) return
    syncingOversight = true
    try {
      for (const child of desired) {
        const previous = oversightSynced.get(child.sessionID)
        const changed =
          !previous ||
          previous.level !== child.level ||
          previous.pinned !== child.pinned ||
          (!child.pinned && previous.assignment !== child.assignment)
        if (!changed) continue
        try {
          if (previous?.level !== child.level || !previous) {
            await putSessionInstruction(child.sessionID, INSTRUCTION_KEYS.oversightLevel, child.level)
          }
          if (!child.pinned || !previous || previous.pinned !== child.pinned || previous.assignment !== child.assignment) {
            await putSessionInstruction(child.sessionID, INSTRUCTION_KEYS.assignmentPrompt, child.assignment)
          }
          oversightSynced.set(child.sessionID, {
            level: child.level,
            pinned: child.pinned,
            assignment: child.assignment,
          })
        } catch {
          // A child that cannot be written keeps its previous entries; retry on the next change.
        }
      }
    } finally {
      syncingOversight = false
    }
  }
  createEffect(() => {
    if (!collabOn()) {
      oversightSynced.clear()
      return
    }
    if (!ready()) return
    const rootID = rootSessionID()
    if (!rootID) return
    const family = new Set(props.context.data.session.family(rootID))
    const assignmentBase = root().assignmentPrompt || SUPERAGENT_DEFAULTS.assignmentPrompt
    const pins = root().oversight.pins
    const desired = sessions()
      .filter((item) => item.id !== rootID && family.has(item.id))
      .map((item) => {
        const contract = oversightFor(item.id)
        return {
          sessionID: item.id,
          level: contract.level,
          pinned: pins.sessions?.[item.id] !== undefined,
          assignment: `${renderReportProtocol(contract)}\n\n${assignmentBase}`,
        }
      })
    if (desired.length === 0) return
    void syncChildOversightEntries(rootID, desired)
  })

  /** 主会话的标题：内部类型名对用户没有意义，用会话标题。 */
  const rootTitle = createMemo(() => {
    const current = session()
    const raw = current ? withTimestampedFallback(current).trim() : ""
    const usable = raw && !/^(New|Child) session/.test(raw) ? raw : ""
    return usable ? `Superagent${SEPARATOR}${usable}` : "Superagent"
  })

  const tree = createMemo(() => {
    const current = session()
    if (!current) return
    const rootNode = toSessionInput(props.context, current)
    if (currentSelection()) rootNode.model = currentSelection()
    const children = sessions()
      .filter((item) => item.id !== current.id)
      .map((item) => toSessionInput(props.context, item))
    const value = buildAgentTree({
      root: rootNode,
      sessions: children,
      tasks: [],
      autoConfigured: autoModels().length > 0,
    })
    decorate(value, root(), rootNode.model, names(), (sessionID) =>
      isExplicitModelDelegation(props.context.data.session.get(sessionID)),
    )
    value.title = rootTitle()
    return value
  })

  /** Flagship identity is the explicit-delegation marker only; model equality with the root never counts. */
  const rootModel = createMemo(() => tree()?.model?.actual)
  const flagshipLimit = createMemo(() => effectiveFlagshipLimit(policy().maxFlagshipSubagents, subagentLimit()))
  const flagshipCount = createMemo(() =>
    countFlagshipSubagents(
      (tree()?.children ?? []).flatMap((node) =>
        node.sessionID
          ? [
              {
                model: node.model?.actual,
                metadata: props.context.data.session.get(node.sessionID)?.metadata,
              },
            ]
          : [],
      ),
    ),
  )
  /** 旗舰数量只用于淘汰，面板不展示。 */

  /**
   * 默认模型批量同步：fixed 变更与 inherit 跟随都把当前 root 下未保护子代理
   * 切到目标模型；auto 没有唯一模型，只影响后续分配。运行中的子代理走
   * 中断→等待停止→切换→续跑，串行处理并逐项报告失败。
   */
  let lastTargetKey: string | undefined
  let appliedTargetKey: string | undefined
  let mountPassDone = false
  let syncingDefaultModels = false
  createEffect(() => {
    if (!ready()) return
    const current = session()
    if (!current) return
    const scoped = root()
    const rootModelRef = rootModel()
    // The tree must be known before a batch runs: the inherit target resolves
    // from the root's current model.
    if (!rootModelRef) return
    const target =
      scoped.defaultPolicy === "fixed"
        ? scoped.defaultModel
        : scoped.defaultPolicy === "inherit"
          ? rootModelRef
          : undefined
    if (!target) return
    const key = `${current.id}|${scoped.defaultPolicy}|${modelKey(target)}`
    if (key === lastTargetKey) return
    lastTargetKey = key
    if (!mountPassDone) {
      // Opening the panel never re-models existing subagents; only subagents
      // created after the default was set pick that default up.
      mountPassDone = true
      if (scoped.defaultPolicy === "fixed") void applyDefaultToNewChildren(current.id, target)
      return
    }
    if (key === appliedTargetKey) return
    appliedTargetKey = key
    void syncDefaultModels(current.id, target).catch(() => {})
  })

  /** Subagents created after the fixed default was set pick that model up. */
  async function applyDefaultToNewChildren(rootID: string, model: ModelRef) {
    const since = root().defaultSetAt
    if (since === undefined) return
    const family = new Set(props.context.data.session.family(rootID))
    const kept = root().keptSubagents ?? {}
    const failures: string[] = []
    for (const item of sessions()) {
      if (item.id === rootID || !family.has(item.id)) continue
      if ((item.time?.created ?? 0) <= since) continue
      const policy = root().policies[item.id]
      // A per-child policy is an explicit choice; the root default never
      // treats it as unset.
      if (policy) continue
      // A protected Subagent keeps its own model; the default never reaches it.
      if (kept[item.id]) continue
      // Explicit `input.model` delegation outranks the default; the marker is
      // valid only while the child still runs that exact model.
      if (isExplicitModelDelegation(item)) continue
      if (item.model && sameModel(item.model, model)) continue
      try {
        // A newly created child already has a running parent/tool call. Apply
        // its default for subsequent attempts without interrupting that call.
        await props.context.client.session.switchModel({ sessionID: item.id, model })
      } catch (error) {
        failures.push(`${subagentTitle(item)}：${errorText(error)}`)
      }
    }
    if (failures.length > 0) {
      props.context.ui.toast.show({
        message: `默认模型应用到新子代理：${failures.length} 个失败（${failures.join("；")}）。`,
      })
    }
  }

  async function syncDefaultModels(rootID: string, target: ModelRef) {
    if (syncingDefaultModels) return
    syncingDefaultModels = true
    try {
      const family = new Set(props.context.data.session.family(rootID))
      const kept = root().keptSubagents ?? {}
      const policies = root().policies
      // Explicit per-child fixed is a manual choice and keeps its model; inherit
      // still follows the root target and auto still manages itself. Explicit
      // `input.model` delegation outranks the default; a stale marker (current
      // model differs from the marked one) does not protect.
      const targets = sessions().filter(
        (item) =>
          item.id !== rootID &&
          family.has(item.id) &&
          !kept[item.id] &&
          policies[item.id] !== "auto" &&
          policies[item.id] !== "fixed" &&
          !isExplicitModelDelegation(item),
      )
      if (targets.length === 0) return
      const label = names().get(modelKey(target)) ?? target.id
      // 默认模型批量同步不是显式旗舰委派：目标与 root 同模型也不做旗舰预检、
      // 不占旗舰名额（旗舰身份只认显式委派的 marker）。
      let switched = 0
      const failures: string[] = []
      for (const item of targets) {
        if (item.model && sameModel(item.model, target)) continue
        const outcome = await switchModelCore(item.id, target)
        if (outcome.error) failures.push(`${subagentTitle(item)}：${outcome.error}`)
        else if (outcome.warn) failures.push(`${subagentTitle(item)}：${outcome.warn}`)
        else switched++
      }
      if (failures.length > 0) {
        props.context.ui.toast.show({
          message: `默认模型批量切换：${switched} 个成功，${failures.length} 个失败（${failures.join("；")}）。`,
        })
      } else if (switched > 0) {
        props.context.ui.toast.show({ message: `已将 ${switched} 个未保护子代理切到 ${label}。` })
      }
    } finally {
      syncingDefaultModels = false
    }
  }

  const rows = createMemo(() => {
    const value = tree()
    if (!value) return []
    const expanded = new Set<string>()
    const collapsed = new Set<string>()
    for (const [id, open] of Object.entries(root().expanded)) (open ? expanded : collapsed).add(id)
    return flattenAgentTree(value, { expanded, collapsed })
  })

  const setExpanded = (id: string, open: boolean) => {
    void updateRoot((draft) => {
      draft.expanded = { ...draft.expanded, [id]: open }
    }).catch(() => {})
  }

  /** 右栏内容的实测宽度；布局完成后由 onSizeChange 回填。 */
  const [measuredWidth, setMeasuredWidth] = createSignal(0)
  /** 可用宽度：实测优先，缺省按标准右栏宽度排版。 */
  const panelWidth = createMemo(() => Math.max(MIN_CONTENT_WIDTH, measuredWidth() || DEFAULT_CONTENT_WIDTH))

  /** 主题强调色：运行中的状态用它。旧主题没有 hue 时退回正文色。 */
  const accentColor = () => {
    const hue = props.context.theme.hue as { accent?: Record<string, unknown> } | undefined
    return (hue?.accent?.[200] as string | undefined) ?? props.context.theme.text.base
  }

  /** 警示色：长时间运行与失败共用。 */
  const warningColor = () => theme.text.feedback?.warning?.base ?? theme.text.muted

  /** 运行时长随时间推进：60s 一次轻量重算，面板销毁时清理。 */
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(clock))

  /**
   * 面板手动操作回传：告诉 root 会话「这是用户手动做的」。
   * 受「子代理状态监测」开关控制，连续操作防抖合并；投递失败只提示，不影响操作本身。
   */
  const manualNotifier = createManualNotifier(props.context, {
    rootID: () => rootSessionID(),
    enabled: () => statusWatch(),
  })
  onCleanup(() => manualNotifier.dispose())

  async function notifyManual(input: {
    action: ManualOpAction
    childID?: string
    childTitle?: string
    detail?: ManualOpDetail
    immediate?: boolean
  }) {
    const sent = await manualNotifier.notify(
      {
        action: input.action,
        childID: input.childID,
        childTitle: input.childTitle,
        detail: input.detail,
      },
      { immediate: input.immediate },
    )
    if (!sent) props.context.ui.toast.show({ message: "已完成，但未能通知 Superagent。" })
  }

  /** 协作模式总开关：只写当前 root 的 `superagent.collab-enabled` 条目。 */
  async function setCollabEnabled(enabled: boolean) {
    await putInstruction(INSTRUCTION_KEYS.collabEnabled, String(enabled))
    props.context.ui.toast.show({
      message: enabled ? "本会话 agents协作已启用。" : "本会话 agents协作已停用。",
    })
    await notifyManual({
      action: "collab",
      detail: { value: enabled ? "启用" : "停用" },
      immediate: true,
    })
  }

  const {
    rowStatus,
    rowPrefix,
    titleColumn,
    rowTitle,
    rowModel,
    rowBadge,
    rowUsage,
    rowInfo,
    titleColor,
    badgeColor,
  } = createRowHelpers({
    context: props.context,
    theme,
    root,
    autoModels,
    now,
    panelWidth,
    oversightFor,
    rootSessionID,
    accentColor,
    warningColor,
  })

  const { configureAutoModels, openDefaults, openModel, pickModel, switchModelCore } = createModelActions({
    context: props.context,
    preferencePath,
    preferences,
    setPreferences,
    models,
    autoModels,
    names,
    updateRoot,
    updateGlobal,
    rememberRecent,
    loadPreferences,
    root,
    tree,
    oversightFor,
    rootSessionID,
    providerName,
    pickerGroups,
    pickerFavorites,
    pickerKey,
    putInstruction,
  })

  /** 默认模型的读法：模型名，或"跟随会话"、"自动"。 */
  const defaultModelName = createMemo(() => {
    const scoped = root()
    if (scoped.defaultPolicy === "auto") return "自动"
    if (scoped.defaultPolicy === "inherit") return "跟随会话"
    const model = scoped.defaultModel
    if (!model) return "跟随会话"
    return names().get(modelKey(model)) ?? model.id
  })

  /** 头部第一行：默认模型。监管等级另起一行，不挂在模型后面。 */
  const defaultLabel = createMemo(() => headerLine("默认模型", defaultModelName()))

  /** 头部第三行：监管等级、等级名与对应的验收深度。 */
  const oversightText = createMemo(() => {
    const contract = rootOversight()
    const acceptance = contract.acceptance?.name
    return headerLine("监管", `L${contract.level} ${contract.name}${acceptance ? `${SEPARATOR}${acceptance}` : ""}`)
  })

  /** 头部文字也按可用宽度收尾，窄栏下不会换行。 */
  const headerText = (text: string) => truncate(text, Math.max(MIN_CONTENT_WIDTH, panelWidth()))

  async function editReportStyle() {
    const selected = await props.context.ui.dialog.select<string>({
      title: "报告风格",
      options: [
        { value: "concise", title: "简洁", description: "只汇报结论与关键改动" },
        { value: "detailed", title: "详细", description: "汇报过程、依据与验证结果" },
      ],
      current: policy().reportStyle,
    })
    if (selected === undefined) return
    await putInstruction(INSTRUCTION_KEYS.reportStyle, selected)
    props.context.ui.toast.show({ message: `报告风格已设为${reportStyleLabel(selected)}。` })
  }

  async function editSessionPrompt() {
    const value = await props.context.ui.dialog.prompt({
      title: "会话补充提示词",
      description: "写入当前主会话的模型指令；留空清除。子代理模型不受影响。",
      placeholder: "例如：优先复用现有组件，不新增依赖",
      value: policy().sessionPrompt,
    })
    if (value === undefined) return
    await saveInstructionText(INSTRUCTION_KEYS.sessionPrompt, value)
    props.context.ui.toast.show({ message: value.trim() ? "会话补充提示词已保存。" : "会话补充提示词已清除。" })
  }

  async function editTaskPrompt() {
    const value = await props.context.ui.dialog.prompt({
      title: "当前任务补充提示词",
      description: "写入当前主会话的模型指令；留空清除。",
      placeholder: "例如：本次只改右栏插件，不动其他模块",
      value: policy().taskPrompt,
    })
    if (value === undefined) return
    await saveInstructionText(INSTRUCTION_KEYS.taskPrompt, value)
    props.context.ui.toast.show({ message: value.trim() ? "当前任务补充提示词已保存。" : "当前任务补充提示词已清除。" })
  }

  async function editMaxSubagents() {
    const value = await props.context.ui.dialog.prompt({
      title: "最大子代理数量",
      description:
        "1–20 的整数：同一主会话下最多保留的子代理数量。超出后自动淘汰最旧的已完成子代理，运行中、已保护与正在查看的子代理不会被删除。",
      placeholder: "例如：5",
      value: policy().maxSubagents,
    })
    if (value === undefined) return
    const text = value.trim()
    if (!text) {
      await removeInstruction(INSTRUCTION_KEYS.maxSubagents)
      await updateRoot((draft) => {
        draft.maxSubagents = SUPERAGENT_DEFAULTS.maxSubagents
      })
      props.context.ui.toast.show({ message: "最大子代理数量已清除。" })
      await notifyManual({
        action: "max-subagents",
        detail: { value: String(SUPERAGENT_DEFAULTS.maxSubagents) },
      })
      return
    }
    const parsed = Number(text)
    if (!/^\d+$/.test(text) || !Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
      props.context.ui.toast.show({ message: "最大子代理数量必须是 1–20 的整数。" })
      return
    }
    await putInstruction(INSTRUCTION_KEYS.maxSubagents, parsed)
    await updateRoot((draft) => {
      draft.maxSubagents = parsed
    })
    props.context.ui.toast.show({ message: `最大子代理数量已设为 ${parsed}。` })
    await notifyManual({ action: "max-subagents", detail: { value: String(parsed) } })
  }

  async function editMaxFlagshipSubagents() {
    const value = await props.context.ui.dialog.prompt({
      title: "旗舰子代理数量",
      description:
        `0–20 的整数：默认 ${DEFAULT_MAX_FLAGSHIP_SUBAGENTS}。旗舰子代理与 Superagent 同 provider/model/variant；仍计入子代理总上限。`,
      placeholder: `例如：${DEFAULT_MAX_FLAGSHIP_SUBAGENTS}`,
      value: policy().maxFlagshipSubagents,
    })
    if (value === undefined) return
    const text = value.trim()
    if (!text) {
      await removeInstruction(INSTRUCTION_KEYS.maxFlagshipSubagents)
      props.context.ui.toast.show({ message: "旗舰子代理数量已清除。" })
      await notifyManual({
        action: "max-flagship",
        detail: { value: String(DEFAULT_MAX_FLAGSHIP_SUBAGENTS) },
      })
      return
    }
    const parsed = Number(text)
    if (!/^\d+$/.test(text) || !Number.isInteger(parsed) || parsed < 0 || parsed > 20) {
      props.context.ui.toast.show({ message: "旗舰子代理数量必须是 0–20 的整数。" })
      return
    }
    await putInstruction(INSTRUCTION_KEYS.maxFlagshipSubagents, parsed)
    props.context.ui.toast.show({ message: `旗舰子代理数量已设为 ${parsed}。` })
    await notifyManual({ action: "max-flagship", detail: { value: String(parsed) } })
  }

  async function editAssignmentPrompt() {
    const value = await props.context.ui.dialog.prompt({
      title: "任务分配微调提示词",
      description: "写入当前主会话的编排指令；留空清除。报告协议会自动加在前面。",
      placeholder: "例如：优先按模块拆分，避免同时修改同一文件",
      value: root().assignmentPrompt,
    })
    if (value === undefined) return
    const text = value.trim()
    await updateRoot((draft) => {
      draft.assignmentPrompt = text
    })
    props.context.ui.toast.show({ message: text ? "任务分配微调提示词已保存。" : "任务分配微调提示词已清除。" })
  }

  /** Picks a fallback model; the choice only writes the entry, never a session. */
  async function editFallbackModel(kind: "superagent" | "subagent") {
    const entryKey =
      kind === "superagent" ? INSTRUCTION_KEYS.fallbackModel : INSTRUCTION_KEYS.subagentFallbackModel
    const title = kind === "superagent" ? "Superagent 备用模型" : "Subagent 备用模型"
    const entry = instructionText(entryKey)
    const slash = entry.indexOf("/")
    const current = slash > 0 ? { providerID: entry.slice(0, slash), id: entry.slice(slash + 1) } : undefined
    const picked = await pickModel(title, current)
    if (!picked) return
    await putInstruction(entryKey, `${picked.providerID}/${picked.id}`)
    props.context.ui.toast.show({ message: `${title}已设为 ${picked.model.name || picked.model.id}。` })
  }

  async function editFallbackThreshold() {
    const value = await props.context.ui.dialog.prompt({
      title: "连续失败次数",
      description: "同一次运行内连续出现多少次限额错误后切换备用模型（1–10 的整数）。",
      placeholder: "例如：3",
      value: String(fallbackThreshold()),
    })
    if (value === undefined) return
    const text = value.trim()
    const parsed = Number(text)
    if (!/^\d+$/.test(text) || !Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
      props.context.ui.toast.show({ message: "连续失败次数必须是 1–10 的整数。" })
      return
    }
    await putInstruction(INSTRUCTION_KEYS.fallbackThreshold, parsed)
    props.context.ui.toast.show({ message: `连续失败 ${parsed} 次后切换备用模型。` })
  }

  async function editFallbackEnabled() {
    const selected = await props.context.ui.dialog.select<FallbackAction>({
      title: "限额自动切换备用模型",
      options: [
        { value: { kind: "on" }, title: "已启用", description: "连续失败达到阈值后切换到备用模型" },
        { value: { kind: "off" }, title: "已停用", description: "限额错误只报错，不切换模型" },
        { value: { kind: "threshold" }, title: "连续失败次数…", description: `当前 ${fallbackThreshold()} 次` },
      ],
      current: fallbackEnabled() ? { kind: "on" } : { kind: "off" },
    })
    if (!selected) return
    if (selected.kind === "threshold") return editFallbackThreshold()
    await putInstruction(INSTRUCTION_KEYS.fallbackEnabled, selected.kind === "on" ? "true" : "false")
    props.context.ui.toast.show({
      message: selected.kind === "on" ? "已启用限额自动切换备用模型。" : "已停用限额自动切换备用模型。",
    })
  }

  async function editCriticEnabled() {
    const selected = await props.context.ui.dialog.select<{ kind: "on" | "off" }>({
      title: "critic 他监督复核",
      options: [
        { value: { kind: "on" }, title: "已启用", description: "子代理完成后由独立会话复核其报告" },
        { value: { kind: "off" }, title: "已停用", description: "不发起复核，只保留已有审计结果" },
      ],
      current: { kind: criticEnabled() ? "on" : "off" },
    })
    if (!selected) return
    await putInstruction(INSTRUCTION_KEYS.criticEnabled, selected.kind === "on" ? "true" : "false")
    props.context.ui.toast.show({
      message: selected.kind === "on" ? "已启用 critic 他监督复核。" : "已停用 critic 他监督复核。",
    })
  }

  async function editStatusWatch() {
    const selected = await props.context.ui.dialog.select<{ kind: "on" | "off" }>({
      title: "子代理状态监测",
      options: [
        { value: { kind: "on" }, title: "已启用", description: "子代理结束或后台任务在跑时回传状态，并做周期对账" },
        { value: { kind: "off" }, title: "已停用", description: "不登记监测、不做对账、不补发状态提醒" },
      ],
      current: { kind: statusWatch() ? "on" : "off" },
    })
    if (!selected) return
    await putInstruction(INSTRUCTION_KEYS.statusWatch, selected.kind === "on" ? "true" : "false")
    props.context.ui.toast.show({
      message: selected.kind === "on" ? "已启用子代理状态监测。" : "已停用子代理状态监测。",
    })
  }

  async function openPolicyEditor() {
    await loadInstructions()
    while (true) {
      const current = policy()
      const selected = await props.context.ui.dialog.select<PolicyAction>({
        title: "当前会话策略",
        placeholder: "选择要修改的策略项",
        options: [
          {
            value: { kind: "report" },
            title: "报告风格",
            description: `${reportStyleLabel(current.reportStyle)}${current.reportStyleCustom ? "" : "（默认）"}`,
          },
          {
            value: { kind: "prompt" },
            title: "会话补充提示词",
            description: `${summarize(current.sessionPrompt)}${current.sessionPromptCustom ? "" : "（默认）"}`,
          },
          { value: { kind: "close" }, title: "完成", description: "返回agents协作设置" },
        ],
      })
      if (!selected || selected.kind === "close") return
      if (selected.kind === "report") await editReportStyle()
      else await editSessionPrompt()
    }
  }

  async function openOversight() {
    const contract = rootOversight()
    const selected = await props.context.ui.dialog.select<OversightAction>({
      title: "监管力度",
      options: [
        {
          value: { kind: "default" },
          title: "恢复默认 L2",
          description: `使用默认监管等级 L2（当前 L${contract.level}）`,
        },
        ...([0, 1, 2, 3, 4] as OversightLevel[]).map((level) => ({
          value: { kind: "pin" as const, level },
          title: `L${level} ${OVERSIGHT_LEVEL_NAMES[level]}`,
          description: OVERSIGHT_LEVEL_DESCRIPTIONS[level],
        })),
      ],
      current: contract.source === "pin" ? { kind: "pin", level: contract.level } : { kind: "default" },
    })
    if (!selected) return
    const id = rootSessionID()
    if (!id) return
    const previous = root().oversight.pins.sessions?.[id]
    if (selected.kind === "default") {
      await updateRoot((draft) => {
        const sessions = { ...draft.oversight.pins.sessions }
        delete sessions[id]
        draft.oversight.pins = { ...draft.oversight.pins, sessions }
      })
      void appendOversightEvent("oversight.pin.changed", {
        rootSessionID: id,
        sessionID: id,
        previous,
        next: null,
      }).catch(() => {})
      props.context.ui.toast.show({ message: "监管力度已恢复默认 L2。" })
      return
    }
    await updateRoot((draft) => {
      draft.oversight.pins = {
        ...draft.oversight.pins,
        sessions: { ...draft.oversight.pins.sessions, [id]: selected.level },
      }
    })
    void appendOversightEvent("oversight.pin.changed", {
      rootSessionID: id,
      sessionID: id,
      previous,
      next: selected.level,
    }).catch(() => {})
    props.context.ui.toast.show({ message: `监管力度已固定为 L${selected.level}。` })
  }

  /** The report protocol of one Subagent, independent of its siblings and the root. */
  async function openSubagentOversight(node: AgentNode) {
    const sessionID = node.sessionID
    if (!sessionID) return
    const contract = oversightFor(sessionID)
    const stored = root().oversight.pins.sessions?.[sessionID]
    const pinned = stored === undefined ? undefined : oversightLevelForPin(stored)
    const source = pinned === undefined ? `跟随默认 L${contract.level}` : `已固定 L${pinned}`
    const selected = await props.context.ui.dialog.select<OversightAction>({
      title: `设置 ${node.title} 的监管力度`,
      placeholder: `当前：${source}`,
      options: [
        { value: { kind: "default" }, title: "跟随默认", description: `跟随 root 默认 L${contract.level}` },
        ...([0, 1, 2, 3, 4] as OversightLevel[]).map((level) => ({
          value: { kind: "pin" as const, level },
          title: `L${level} ${OVERSIGHT_LEVEL_NAMES[level]}`,
          description: OVERSIGHT_LEVEL_DESCRIPTIONS[level],
        })),
      ],
      current: pinned === undefined ? { kind: "default" } : { kind: "pin", level: pinned },
    })
    if (!selected) return
    const previous = stored
    if (selected.kind === "default") {
      await updateRoot((draft) => {
        const sessions = { ...draft.oversight.pins.sessions }
        delete sessions[sessionID]
        draft.oversight.pins = { ...draft.oversight.pins, sessions }
      })
      void appendOversightEvent("oversight.pin.changed", {
        rootSessionID: rootSessionID(),
        sessionID,
        previous,
        next: null,
      }).catch(() => {})
      props.context.ui.toast.show({ message: `${node.title} 已恢复跟随默认 L${contract.level}。` })
      await notifyManual({
        action: "oversight",
        childID: sessionID,
        childTitle: node.title,
        detail: { value: `跟随默认 L${contract.level}` },
      })
      return
    }
    await updateRoot((draft) => {
      draft.oversight.pins = {
        ...draft.oversight.pins,
        sessions: { ...draft.oversight.pins.sessions, [sessionID]: selected.level },
      }
    })
    void appendOversightEvent("oversight.pin.changed", {
      rootSessionID: rootSessionID(),
      sessionID,
      previous,
      next: selected.level,
    }).catch(() => {})
    props.context.ui.toast.show({ message: `${node.title} 的监管力度已固定为 L${selected.level}。` })
    await notifyManual({
      action: "oversight",
      childID: sessionID,
      childTitle: node.title,
      detail: { value: `L${selected.level}` },
    })
  }

  async function openSettings() {
    await initializeInstructions()
    const current = policy()
    const selected = await props.context.ui.dialog.select<SettingsAction>({
      title: "agents协作设置",
      options: [
        {
          value: { kind: "collabSwitch" },
          title: "协作模式总开关",
          description: collabOn()
            ? "已启用 · 仅当前会话；关闭后拦截、切换、复核、探针全部停止"
            : "已停用 · 仅当前会话；面板只留一行，左键可重新开启",
        },
        {
          value: { kind: "oversight" },
          title: "监管力度",
          description: `${oversightLabel(rootOversight())} · ${rootOversight().source === "pin" ? "已固定" : "默认"}`,
        },
        {
          value: { kind: "policy" },
          title: "当前会话策略",
          description: [
            `${reportStyleLabel(current.reportStyle)}${current.reportStyleCustom ? "" : "（默认）"}`,
            `${summarize(current.sessionPrompt)}${current.sessionPromptCustom ? "" : "（默认）"}`,
          ].join(" · "),
        },
        {
          value: { kind: "maxSubagents" },
          title: "最大子代理数量",
          description: `${current.maxSubagents}${current.maxSubagentsCustom ? "" : "（默认）"} · 超出后自动淘汰最旧的已完成子代理`,
        },
        {
          value: { kind: "maxFlagshipSubagents" },
          title: "旗舰子代理数量",
          description: `${current.maxFlagshipSubagents}${current.maxFlagshipSubagentsCustom ? "" : "（默认）"} · 与 Superagent 同模型；仍计入子代理总上限`,
        },
        {
          value: { kind: "assignmentPrompt" },
          title: "任务分配微调提示词",
          description: `${summarize(current.assignmentPrompt)}${current.assignmentPromptCustom ? "" : "（默认）"}`,
        },
        {
          value: { kind: "taskPrompt" },
          title: "当前任务补充提示词",
          description: current.taskPromptCustom ? summarize(current.taskPrompt) : "无补充，使用全局规则",
        },
        {
          value: { kind: "defaults" },
          title: "子代理默认模型",
          description: defaultModelName(),
        },
        {
          value: { kind: "fallbackModel" },
          title: "Superagent 备用模型",
          description: fallbackSummary(),
        },
        {
          value: { kind: "subagentFallbackModel" },
          title: "Subagent 备用模型",
          description: subagentFallbackSummary(),
        },
        {
          value: { kind: "fallbackEnabled" },
          title: "限额自动切换备用模型",
          description: fallbackEnabled()
            ? `已启用${SEPARATOR}连续${fallbackThreshold()}次失败切换`
            : "已停用",
        },
        {
          value: { kind: "criticEnabled" },
          title: "critic 他监督复核",
          description: criticEnabled() ? "已启用" : "已停用",
        },
        {
          value: { kind: "statusWatch" },
          title: "子代理状态监测",
          description: statusWatch() ? "已启用" : "已停用",
        },
        {
          value: { kind: "auto" },
          title: "配置全局自动模型",
          description: autoModels().length > 0 ? `${autoModels().length} 个已选模型` : "未配置（禁用）",
        },
        {
          value: { kind: "restore" },
          title: "恢复默认编排策略",
          description: "写入默认值到当前 Session",
        },
      ],
    })
    if (!selected) return
    if (selected.kind === "collabSwitch") return setCollabEnabled(!collabOn())
    if (selected.kind === "oversight") return openOversight()
    if (selected.kind === "policy") return openPolicyEditor()
    if (selected.kind === "maxSubagents") return editMaxSubagents()
    if (selected.kind === "maxFlagshipSubagents") return editMaxFlagshipSubagents()
    if (selected.kind === "assignmentPrompt") return editAssignmentPrompt()
    if (selected.kind === "taskPrompt") return editTaskPrompt()
    if (selected.kind === "restore") return restoreDefaults()
    if (selected.kind === "defaults") return openDefaults()
    if (selected.kind === "fallbackModel") return editFallbackModel("superagent")
    if (selected.kind === "subagentFallbackModel") return editFallbackModel("subagent")
    if (selected.kind === "fallbackEnabled") return editFallbackEnabled()
    if (selected.kind === "criticEnabled") return editCriticEnabled()
    if (selected.kind === "statusWatch") return editStatusWatch()
    return configureAutoModels()
  }

  /** Deletes the Subagent session and its context; nothing is recreated. */
  async function deleteSubagent(node: AgentNode) {
    if (!node.sessionID) return
    const sessionID = node.sessionID
    const title = node.title
    const confirmed = await props.context.ui.dialog.confirm({
      title: "删除 Subagent",
      message: `删除 ${node.title}？该子会话及其上下文会被永久删除，无法恢复。`,
      label: { confirm: "删除 Subagent", cancel: "取消" },
    })
    if (!confirmed) return
    await props.context.client.session.remove({ sessionID })
    props.context.ui.toast.show({ message: `${node.title} 已删除。` })
    await notifyManual({ action: "delete", childID: sessionID, childTitle: title, immediate: true })
  }

  async function compactSubagent(node: AgentNode) {
    if (!node.sessionID) return
    const sessionID = node.sessionID
    const title = node.title
    await props.context.client.session.compact({ sessionID })
    props.context.ui.toast.show({ message: `已发起 ${node.title} 的原生上下文压缩。` })
    await notifyManual({ action: "compact", childID: sessionID, childTitle: title, immediate: true })
  }

  /** Protects a Subagent from automatic eviction and from model changes. */
  async function toggleKeep(node: AgentNode) {
    const sessionID = node.sessionID
    if (!sessionID) return
    const title = node.title
    const kept = Boolean(root().keptSubagents?.[sessionID])
    const next = { ...root().keptSubagents }
    if (kept) delete next[sessionID]
    else next[sessionID] = true
    await updateRoot((draft) => {
      draft.keptSubagents = next
    })
    await writeKeptEntry(next).catch(() => {})
    props.context.ui.toast.show({
      message: kept
        ? `${node.title} 已取消保护，可被自动淘汰，模型也可以被修改。`
        : `${node.title} 已保护，不会被自动淘汰，模型也不会被修改；取消保护后才可改。`,
    })
    await notifyManual({
      action: kept ? "unkeep" : "keep",
      childID: sessionID,
      childTitle: title,
    })
  }

  const { evictExcessSubagents } = createEvictionActions({
    context: props.context,
    sessionID: props.sessionID,
    rootSessionID,
    root,
    subagentLimit,
    directSubagents,
    tree,
    flagshipLimit,
  })
  createEffect(() => {
    if (!ready()) return
    if (!collabOn()) return
    directSubagents().length
    subagentLimit()
    flagshipCount()
    flagshipLimit()
    void evictExcessSubagents()
  })

  async function openOversightAudit() {
    const events = await recentOversightEvents(20)
    const message =
      events.length > 0
        ? events
            .slice()
            .reverse()
            .map((event) => `${String(event.ts ?? "")} ${String(event.type ?? "")} ${JSON.stringify(event.oversight ?? {})}`)
            .join("\n")
        : "暂无监管审计事件。"
    await props.context.ui.dialog.alert({ title: "监管审计（最近 20 条）", message })
  }

  async function openActions(node: AgentNode) {
    if (node.kind !== "subagent") return
    const kept = Boolean(node.sessionID && root().keptSubagents?.[node.sessionID])
    const selected = await props.context.ui.dialog.select<AgentAction>({
      title: node.title,
      options: [
        { value: { kind: "model" }, title: "修改模型", description: "修改这个子代理的模型策略" },
        { value: { kind: "open" }, title: "打开子会话", description: "切换到该子代理会话" },
        { value: { kind: "compact" }, title: "压缩上下文", description: "对该子代理发起原生上下文压缩" },
        {
          value: { kind: "keep" },
          title: kept ? "取消保护" : "保护此子代理",
          description: kept
            ? "允许自动淘汰这个子代理，模型也可以被修改"
            : "不会被自动淘汰，模型也不会被修改；取消保护后才可改",
        },
        { value: { kind: "delete" }, title: "删除 Subagent", description: "删除该子会话及其上下文，不可恢复" },
      ],
    })
    if (!selected) return
    if (selected.kind === "model") return openModel(node)
    if (selected.kind === "compact") return compactSubagent(node)
    if (selected.kind === "keep") return toggleKeep(node)
    if (selected.kind === "delete") return deleteSubagent(node)
    if (node.sessionID) props.context.ui.router.navigate({ type: "session", sessionID: node.sessionID })
  }

  return (
    <AgentPanelView
      collabOn={collabOn}
      setCollabEnabled={setCollabEnabled}
      theme={theme}
      tree={tree}
      openSettings={openSettings}
      openDefaults={openDefaults}
      setMeasuredWidth={setMeasuredWidth}
      headerText={headerText}
      defaultLabel={defaultLabel}
      subagentOverLimit={subagentOverLimit}
      openOversightAudit={openOversightAudit}
      subagentCountText={subagentCountText}
      openOversight={openOversight}
      oversightText={oversightText}
      rows={rows}
      setExpanded={setExpanded}
      rowPrefix={rowPrefix}
      titleColor={titleColor}
      rowTitle={rowTitle}
      openActions={openActions}
      rowInfo={rowInfo}
      warningColor={warningColor}
      openModel={openModel}
      badgeColor={badgeColor}
      openSubagentOversight={openSubagentOversight}
      criticRecord={criticRecord}
      criticColor={criticColor}
      openCritic={openCritic}
      criticIndent={criticIndent}
    />
  )
}

/** Plugin ids own the durable storage namespace; keep the pre-rename one here. */
export const PLUGIN_ID = "superagent.agents"
export const STORAGE_KEY = "superagent.agents"

export default PluginDef.define({
  id: PLUGIN_ID,
  setup(context) {
    migrateLegacyPluginStorage(storageDirectory(context.app.channel), STORAGE_KEY, PLUGIN_ID)
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarAgents context={context} sessionID={props.sessionID} />,
    })
  },
})
