/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { Plugin as PluginDef } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  buildAgentTree,
  flattenAgentTree,
  modelLabel,
  type AgentNode,
  type FlatNode,
  type ModelView,
  type SessionInput,
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
import { planEviction, type SubagentChild } from "./subagent-limit"
import { sessionRunning, sessionStatusView } from "./run-duration"
import { migrateLegacyPluginStorage, storageDirectory } from "./storage-migration"
import { buildHandoffSummary, type HandoffClient } from "./handoff"

type ModelInfo = {
  providerID: string
  id: string
  name?: string
  description?: string
  variants?: Array<{ id: string }>
  enabled?: boolean
  status?: string
  cost?: Array<{ input: number; output?: number }>
}
type ProviderInfo = { id: string; name: string }
type SessionInfo = {
  id: string
  parentID?: string
  title?: string
  agent?: string
  model?: ModelRef
  location?: unknown
  outcome?: string
  time?: { created: number; updated: number; archived?: number; busy?: number; idle?: number }
}
type Policy = "auto" | "inherit" | "fixed"

type ModelChoice =
  | { kind: "auto" }
  | { kind: "inherit" }
  | { kind: "model"; model: ModelInfo }
  | { kind: "configure" }

type SettingsAction =
  | { kind: "collabSwitch" }
  | { kind: "oversight" }
  | { kind: "policy" }
  | { kind: "maxSubagents" }
  | { kind: "assignmentPrompt" }
  | { kind: "taskPrompt" }
  | { kind: "restore" }
  | { kind: "defaults" }
  | { kind: "auto" }
  | { kind: "fallbackModel" }
  | { kind: "subagentFallbackModel" }
  | { kind: "fallbackEnabled" }
  | { kind: "criticEnabled" }

type FallbackAction = { kind: "on" } | { kind: "off" } | { kind: "threshold" }

type PolicyAction = { kind: "report" } | { kind: "prompt" } | { kind: "close" }
type DefaultAction = { kind: "auto" } | { kind: "inherit" } | { kind: "choose" } | { kind: "configure" }
type OversightAction = { kind: "default" } | { kind: "pin"; level: OversightLevel }
type AgentAction =
  | { kind: "model" }
  | { kind: "open" }
  | { kind: "recreate" }
  | { kind: "compact" }
  | { kind: "keep" }

/** Instruction entry keys are slash-free, so the logical namespaces use dots. */
const INSTRUCTION_KEYS = {
  reportStyle: "superagent.report-style",
  sessionPrompt: "superagent.session-prompt",
  taskPrompt: "superagent.task-prompt",
  maxSubagents: "superagent.max-subagents",
  oversight: "superagent.oversight",
  assignmentPrompt: "superagent.assignment-prompt",
  defaultModel: "superagent.default-model",
  fallbackModel: "superagent.fallback-model",
  subagentFallbackModel: "superagent.subagent-fallback-model",
  fallbackThreshold: "superagent.fallback-threshold",
  fallbackEnabled: "superagent.fallback-enabled",
  criticEnabled: "superagent.critic-enabled",
  keptSubagents: "superagent.kept-subagents",
} as const

/** 各级监管的实现程度：选择器里介绍"管到什么程度"，不写操作说明。 */
export const OVERSIGHT_LEVEL_DESCRIPTIONS: Record<OversightLevel, string> = {
  0: "只交结果：改动/测试/风险，完成时一次汇报",
  1: "加命令清单与阶段小结，完成时一次汇报",
  2: "加阅读记录与失败详情，证据可核查（默认）",
  3: "加完整输出与代码摘录，每阶段中途简报",
  4: "逐步汇报动机与假设，全程可审计",
}

/** Provider-neutral defaults: unset means follow the session's own model. */
export const SUPERAGENT_DEFAULTS = {
  reportStyle: "concise",
  maxSubagents: 5,
  defaultPolicy: "inherit" as Policy,
  defaultModel: undefined as ModelRef | undefined,
  autoModels: [] as ModelRef[],
  fallbackModel: undefined as ModelRef | undefined,
  subagentFallbackModel: undefined as ModelRef | undefined,
  fallbackThreshold: 3,
  fallbackEnabled: true,
  criticEnabled: false,
  sessionPrompt: [
    "主代理（Superagent）负责：分析需求、拆解任务、方案设计（架构/接口/交互/版面等具体设计）、编写任务书与验收标准、派工和验收。设计产物由主代理产出后交给 Subagent 实现，不让 Subagent 自行决定设计方向。",
    "主代理不做具体实现：改代码、写文件、调试、测试执行交给 Subagent；只读分析（读代码/查文档/调研）主代理可自己做。",
    "派工新建与续跑：与既有子代理无关联的新任务一律新建 Subagent，避免无关上下文污染；仅同一模块/同一文件的后续修改、验收打回返工、类似任务迭代时才 steer 续跑已有子代理。续跑对象上下文较长（>300k）时先判断是否有必要保持：任务需要这些上下文则直接续跑；无必要则先 compact 再续跑。交接摘要仅用于删除重建场景，不是续跑的前置动作。",
    "验收：按报告协议逐项核查（状态三行、章节完整性、证据真实性）；排版/UI 类必须亲眼看实际渲染结果（截图）验收，不只信报告；证据不足或与 session 记录不符打回。",
  ].join("\n"),
  assignmentPrompt:
    "按任务书执行，不扩大范围；修改后运行约定验证；报告修改文件、测试命令与结果、未解决风险；需求不清先提问，不自行决定。",
  taskPrompt: "",
} as const

const REPORT_STYLE_LABELS: Record<string, string> = {
  concise: "简洁",
  detailed: "详细",
  简洁: "简洁",
  详细: "详细",
}

const normalizeReportStyle = (value: string) =>
  value === "简洁" ? "concise" : value === "详细" ? "detailed" : value
const reportStyleLabel = (value: string) => REPORT_STYLE_LABELS[value] ?? value

const summarize = (value: string) => (value.length > 30 ? `${value.slice(0, 29)}…` : value)

type CriticRecord = { verdict: string; differences: string[]; ts: string }

function criticDirectory() {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "opencode", "superagent", "critic")
}

/** Latest critic audit row per reviewed child session. */
async function readCriticRecords(directory: string) {
  const records = new Map<string, CriticRecord>()
  const files = await readdir(directory).catch(() => [] as string[])
  for (const file of files.filter((name) => name.endsWith(".jsonl")).sort()) {
    const text = await readFile(join(directory, file), "utf8").catch(() => "")
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      let row: Record<string, unknown>
      try {
        row = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof row.childSessionID !== "string" || typeof row.verdict !== "string") continue
      const ts = typeof row.ts === "string" ? row.ts : ""
      const previous = records.get(row.childSessionID)
      if (previous && previous.ts > ts) continue
      records.set(row.childSessionID, {
        verdict: row.verdict,
        differences: Array.isArray(row.differences)
          ? row.differences.filter((item): item is string => typeof item === "string")
          : [],
        ts,
      })
    }
  }
  return records
}

/** The mark of one verdict: agreeing reviews fade out, disagreement warns. */
function criticView(verdict: string) {
  if (verdict === "一致") return { text: "✓复核", warning: false }
  if (verdict === "部分不一致" || verdict === "严重不一致") return { text: "⚠复核", warning: true }
  return { text: "?复核", warning: false }
}

type PreferenceModel = { providerID: string; modelID: string }
type ModelPreference = {
  recent: PreferenceModel[]
  favorite: PreferenceModel[]
  variant: Record<string, string | undefined>
}

function defaultModelPreferencePath() {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "opencode", "model.json")
}

/**
 * 协作模式总开关：与 server 入口读同一个文件 `<XDG_CONFIG_HOME>/opencode/superagent.json`
 * （`{ "enabled": true }`）。TUI 侧独立实现一份带短缓存的读取，避免面板渲染时反复读盘。
 * 缺文件 / 读不懂一律按启用处理。
 */
export const COLLAB_SWITCH_TTL_MS = 5000

export function collabSwitchPath() {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
  return join(base, "opencode", "superagent.json")
}

let collabSwitchCache: { checkedAt: number; enabled: boolean } | undefined

export function resetCollabSwitchCache() {
  collabSwitchCache = undefined
}

export function readCollabEnabled(now = Date.now()) {
  if (collabSwitchCache && now - collabSwitchCache.checkedAt < COLLAB_SWITCH_TTL_MS) return collabSwitchCache.enabled
  let enabled = true
  try {
    const parsed: unknown = JSON.parse(readFileSync(collabSwitchPath(), "utf8"))
    if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).enabled === "boolean") {
      enabled = Boolean((parsed as Record<string, unknown>).enabled)
    }
  } catch {
    enabled = true
  }
  collabSwitchCache = { checkedAt: now, enabled }
  return enabled
}

/** 写开关并立即刷新本地缓存，面板无需等下一次轮询。 */
export async function writeCollabSwitch(enabled: boolean) {
  const file = collabSwitchPath()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ enabled }, null, 2) + "\n", "utf8")
  collabSwitchCache = { checkedAt: Date.now(), enabled }
}

/** 上下文偏长的提示阈值：子代理当前上下文超过它就把读数染成警示色。 */
export const CONTEXT_WARN_TOKENS = 300_000

export type SessionTokenUsage = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

type ContextMessage = { type?: string; status?: string; tokens?: SessionTokenUsage }

/**
 * 当前上下文长度：最近一次 assistant 调用的输入侧 tokens（input + cache read/write），
 * 即这一次实际送进模型的提示规模。与原生 `lastAssistantWithUsage` 同口径：
 * 跳过一次完成的 compact 之前的旧记录，compact 后新一步的输入变小，读数随之下降。
 */
export function contextTokens(messages: ReadonlyArray<ContextMessage> | undefined): number | undefined {
  if (!messages || messages.length === 0) return undefined
  const boundary = messages.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
  for (let index = messages.length - 1; index > boundary; index -= 1) {
    const message = messages[index]
    if (message.type !== "assistant" || !message.tokens) continue
    const input = message.tokens.input + message.tokens.cache.read + message.tokens.cache.write
    return input > 0 ? input : undefined
  }
  return undefined
}

/** `950` / `1.2k` / `32k` / `1.1m`：信息行里只占几列。 */
export function formatTokenCount(tokens: number) {
  if (!Number.isFinite(tokens) || tokens <= 0) return ""
  if (tokens < 1_000) return String(Math.round(tokens))
  if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`
}

/** 信息行里的上下文读数：无数据返回 undefined，超过阈值带上警示标记。 */
export function contextUsageView(messages: ReadonlyArray<ContextMessage> | undefined) {
  const tokens = contextTokens(messages)
  if (tokens === undefined) return undefined
  return { tokens, text: `ctx ${formatTokenCount(tokens)}`, warning: tokens > CONTEXT_WARN_TOKENS }
}


function oversightAuditPath(date = new Date()) {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "opencode", "superagent", "oversight", `${date.toISOString().slice(0, 10)}.jsonl`)
}

async function appendOversightEvent(type: string, payload: Record<string, unknown>) {
  const file = oversightAuditPath()
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify({ v: 1, ts: new Date().toISOString(), type, ...payload }) + "\n", "utf8")
}

async function recentOversightEvents(limit = 20) {
  const file = oversightAuditPath()
  const lines = await readFile(file, "utf8")
    .then((text) => text.trim().split("\n").filter(Boolean).slice(-limit))
    .catch(() => [])
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}

function preferenceModels(value: unknown): PreferenceModel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): PreferenceModel[] => {
    if (!item || typeof item !== "object") return []
    const record = item as Record<string, unknown>
    if (typeof record.providerID !== "string" || !record.providerID) return []
    if (typeof record.modelID !== "string" || !record.modelID) return []
    return [{ providerID: record.providerID, modelID: record.modelID }]
  })
}

function decodePreferences(value: unknown) {
  const root = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return {
    document: root,
    preference: {
      recent: preferenceModels(root.recent),
      favorite: preferenceModels(root.favorite),
      variant: root.variant && typeof root.variant === "object" ? (root.variant as ModelPreference["variant"]) : {},
    } satisfies ModelPreference,
  }
}

function recentModels(model: PreferenceModel, recent: PreferenceModel[]) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
}

function favoriteModels(model: PreferenceModel, favorite: PreferenceModel[], enabled: boolean) {
  const current = favorite.filter((item) => !(item.providerID === model.providerID && item.modelID === model.modelID))
  return enabled ? [model, ...current] : current
}

async function readModelPreference(filePath: string) {
  try {
    return decodePreferences(JSON.parse(await readFile(filePath, "utf8")))
  } catch {
    return decodePreferences(undefined)
  }
}

async function writeModelPreference(filePath: string, document: Record<string, unknown>) {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", "utf8")
  await rename(temporary, filePath)
}

let preferenceWrite: Promise<unknown> = Promise.resolve()

async function updateModelPreference(
  filePath: string,
  change: (current: ModelPreference) => Partial<ModelPreference>,
) {
  const run = preferenceWrite.then(async () => {
    const { document, preference } = await readModelPreference(filePath)
    const patch = change(preference)
    const next = {
      ...document,
      ...(patch.recent === undefined ? {} : { recent: preferenceModels(patch.recent) }),
      ...(patch.favorite === undefined ? {} : { favorite: preferenceModels(patch.favorite) }),
      ...(patch.variant === undefined ? {} : { variant: patch.variant }),
    }
    await writeModelPreference(filePath, next)
    return decodePreferences(next).preference
  })
  preferenceWrite = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

const key = (model: ModelRef) =>
  `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
const isFreeModel = (model: ModelInfo) => Boolean(model.cost?.length) && model.cost!.every((cost) => cost.input === 0)
const isFreeGroupModel = (model: ModelInfo) => model.providerID === "opencode" && isFreeModel(model)

/** One section of the bundled picker, matching a group of OpenCode's /models. */
export type PickerGroup = { title: string; models: ModelInfo[] }

/** A picker row: a section title, or a model with the section it came from. */
type PickerRow =
  | { kind: "header"; title: string }
  | { kind: "model"; model: ModelInfo; section: string; favorite: boolean }

const pickerKey = (model: { providerID: string; id: string }) => `${model.providerID}/${model.id}`

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

/** 面板内唯一的分隔符：两侧各一个空格。 */
const SEPARATOR = " · "

/** 右栏内容的默认宽度；实测宽度不可用时按标准右栏宽度排版。 */
const DEFAULT_CONTENT_WIDTH = 36

/** 窄栏下至少保留的宽度，保证状态与标题还放得下。 */
const MIN_CONTENT_WIDTH = 12

/** 头部标签列宽：标签补齐到这里，值列对齐。 */
const HEADER_LABEL_WIDTH = 10

/** 头部一行：标签补齐到同一宽度，值列对齐。 */
function headerLine(label: string, value: string) {
  return `${label}${" ".repeat(Math.max(1, HEADER_LABEL_WIDTH - displayWidth(label)))}${value}`
}

/** 显示宽度：CJK、全角与表情占两列。 */
function charWidth(char: string) {
  const code = char.codePointAt(0) ?? 0
  if (code === 0x200d) return 0
  if (code >= 0x1100 && code <= 0x115f) return 2
  if (code >= 0x2e80 && code <= 0x303e) return 2
  if (code >= 0x3041 && code <= 0x33ff) return 2
  if (code >= 0x3400 && code <= 0x4dbf) return 2
  if (code >= 0x4e00 && code <= 0x9fff) return 2
  if (code >= 0xa000 && code <= 0xa4cf) return 2
  if (code >= 0xac00 && code <= 0xd7a3) return 2
  if (code >= 0xf900 && code <= 0xfaff) return 2
  if (code >= 0xfe30 && code <= 0xfe6f) return 2
  if (code >= 0xff00 && code <= 0xff60) return 2
  if (code >= 0xffe0 && code <= 0xffe6) return 2
  if (code >= 0x1f300 && code <= 0x1faff) return 2
  if (code >= 0x20000 && code <= 0x3fffd) return 2
  return 1
}

/** 文本在终端里占的列数。 */
function displayWidth(text: string) {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/** 截断到给定列数，超出部分用省略号收尾。 */
function truncate(text: string, width: number) {
  if (width <= 0) return ""
  if (displayWidth(text) <= width) return text
  let used = 0
  let out = ""
  for (const char of text) {
    const size = charWidth(char)
    if (used + size > width - 1) break
    out += char
    used += size
  }
  return `${out}…`
}

/** 会话是否正在执行。 */
function isSessionRunning(context: Plugin.Context, sessionID: string) {
  const raw = context.data.session.status(sessionID)
  return raw === "running" || String(raw) === "busy"
}

/** 等待会话的执行真正停下来；超时返回 false。 */
async function waitForSessionIdle(context: Plugin.Context, sessionID: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isSessionRunning(context, sessionID)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !isSessionRunning(context, sessionID)
}

/** 面向用户的错误说明。 */
function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function withTimestampedFallback(session: SessionInfo) {
  return (
    session.title ??
    `${session.parentID ? "Child" : "New"} session - ${new Date(session.time?.created ?? Date.now()).toISOString()}`
  )
}

/** 会话标题：去掉 "@explore subagent" 这类内部标记，类型前缀不进面板。 */
function subagentTitle(session: SessionInfo) {
  const title = withTimestampedFallback(session)
  const agentMatch = title.match(/@(\w+) subagent/)
  return agentMatch ? title.replace(agentMatch[0], "").trim() || title : title
}

function latestUserMessage(context: Plugin.Context, sessionID: string) {
  const messages = context.data.session.message.list(sessionID) ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type === "user" && message.text.trim()) return message.text
  }
  return undefined
}

/**
 * 一行的状态。活跃执行集合优先（与原生 Subagents 面板同源）：取消后重启仍在跑的
 * 会话即使残留 outcome，也必须显示运行中。运行中的子代理附带已运行时长。
 */
function displayStatus(context: Plugin.Context, sessionID: string, options?: { now?: number; duration?: boolean }) {
  return sessionStatusView(context.data.session.get(sessionID), isSessionRunning(context, sessionID), {
    now: options?.now ?? Date.now(),
    duration: options?.duration ?? false,
  })
}

function rootModelLabel(view: ModelView | undefined) {
  if (!view?.actual) return ""
  return view.display ?? modelKey(view.actual)
}

function toSessionInput(context: Plugin.Context, session: SessionInfo): SessionInput {
  return {
    id: session.id,
    parentID: session.parentID,
    title: subagentTitle(session),
    agent: session.agent,
    status: context.data.session.status(session.id),
    model: session.model,
    updated: session.time?.updated ?? 0,
    created: session.time?.created ?? 0,
  }
}

function decorate(node: AgentNode, settings: RootSettings, parentModel: ModelRef | undefined, names: Map<string, string>) {
  const applyName = (model: ModelRef | undefined) => {
    if (!model) return
    const name = names.get(modelKey(model)) ?? names.get(`${model.providerID}/${model.id}`)
    if (!name) return
    if (!node.model) return
    node.model.display = name
  }

  if (node.kind === "root") {
    if (node.model?.actual) {
      const actual = node.model.actual
      node.model.display = names.get(modelKey(actual)) ?? names.get(`${actual.providerID}/${actual.id}`) ?? actual.id
    }
  }

  if (node.kind !== "root" && node.sessionID) {
    const explicit = settings.policies[node.sessionID]
    const policy = explicit ?? settings.defaultPolicy ?? "inherit"
    const newerThanDefault =
      node.created !== undefined && settings.defaultSetAt !== undefined && node.created > settings.defaultSetAt
    const fixedDefault =
      settings.defaultPolicy === "fixed" && settings.defaultModel && newerThanDefault ? settings.defaultModel : undefined
    const actual =
      explicit === "fixed"
        ? node.model?.actual ?? parentModel
        : explicit === "auto"
          ? node.model?.actual
          : policy === "inherit"
            ? parentModel
            : policy === "auto"
              ? node.model?.actual
              : fixedDefault ?? node.model?.actual ?? settings.defaultModel ?? parentModel
    node.model =
      policy === "auto"
        ? { policy: { kind: "auto" }, actual }
        : policy === "inherit"
          ? { policy: { kind: "inherit" }, actual: parentModel }
          : actual ?? parentModel
            ? { policy: { kind: "fixed", model: actual ?? parentModel! }, actual: actual ?? parentModel }
            : undefined
  }
  applyName(node.model?.actual)
  for (const child of node.children) decorate(child, settings, parentModel, names)
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
          const score = pickerScore(needle, `${item.model.name || item.model.id} ${item.section}`.toLowerCase())
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

  const [instructions, setInstructions] = createSignal<Record<string, unknown>>({})
  /** True once this root's instructions (and thus its cap) are loaded. */
  const [ready, setReady] = createSignal(false)
  const instructionText = (key: string) => {
    const value = instructions()[key]
    return typeof value === "string" ? value : typeof value === "number" ? String(value) : ""
  }
  const instructionPresent = (key: string) => {
    const value = instructions()[key]
    return value !== undefined && value !== null && String(value).trim() !== ""
  }

  /** The family root of the session the user is looking at. */
  const rootSessionID = createMemo(() => props.context.data.session.root(props.sessionID))
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
      assignmentPrompt: root().assignmentPrompt || SUPERAGENT_DEFAULTS.assignmentPrompt,
      assignmentPromptCustom: root().assignmentPrompt !== "" && root().assignmentPrompt !== SUPERAGENT_DEFAULTS.assignmentPrompt,
    }
  })

  const session = createMemo(() => props.context.data.session.get(rootSessionID()))
  const sessions = createMemo(() =>
    props.context.data.session.list().filter((item) => item.time?.archived === undefined),
  )
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

  async function loadInstructions() {
    const id = rootSessionID()
    if (!id) return
    const entries = await props.context.client.experimental.session.instructions.entry.list({ sessionID: id })
    setInstructions(Object.fromEntries(entries.map((entry) => [entry.key, entry.value])))
  }
  createEffect(() => {
    const id = rootSessionID()
    if (!id) return
    // 停用时不为会话初始化/补写指令条目；重新开启后本 effect 会再跑。
    if (!collabOn()) return
    void initializeInstructions().catch(() => {})
  })
  async function putInstruction(key: string, value: string | number) {
    const id = rootSessionID()
    if (!id) return
    await props.context.client.experimental.session.instructions.entry.put({
      sessionID: id,
      key,
      value,
    })
    setInstructions((current) => ({ ...current, [key]: value }))
  }
  async function removeInstruction(key: string) {
    const id = rootSessionID()
    if (!id) return
    await props.context.client.experimental.session.instructions.entry.remove({
      sessionID: id,
      key,
    })
    setInstructions((current) => {
      const next = { ...current }
      delete next[key]
      return next
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
    mergeKeptEntry()
    await ensureFallbackDefaults()
    if (!root().initialized[id]) {
      for (const [key, value] of defaultInstructionEntries()) {
        if (instructions()[key] !== undefined) continue
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
    ])
    for (const [key, value] of defaultInstructionEntries()) {
      if (!keys.has(key) || instructions()[key] !== undefined) continue
      await putInstruction(key, value)
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
    await removeInstruction(INSTRUCTION_KEYS.taskPrompt)
    await updateRoot((draft) => {
      draft.defaultPolicy = SUPERAGENT_DEFAULTS.defaultPolicy
      draft.defaultModel = SUPERAGENT_DEFAULTS.defaultModel
      draft.defaultSetAt = Date.now()
      draft.assignmentPrompt = ""
    })
    await updateGlobal((draft) => {
      draft.autoModels = [...SUPERAGENT_DEFAULTS.autoModels]
    })
    props.context.ui.toast.show({ message: "已恢复默认编排策略。" })
  }

  const models = createMemo(() =>
    ((props.context.data.location.model.list(session()?.location) ?? []) as ModelInfo[]).filter(
      (model) => model.status !== "deprecated",
    ),
  )

  /** Entry defaults for this root; optional models only when the catalog has them. */
  function defaultInstructionEntries(): Array<[string, string | number]> {
    const entries: Array<[string, string | number]> = [
      [INSTRUCTION_KEYS.reportStyle, SUPERAGENT_DEFAULTS.reportStyle],
      [INSTRUCTION_KEYS.maxSubagents, SUPERAGENT_DEFAULTS.maxSubagents],
      [INSTRUCTION_KEYS.sessionPrompt, SUPERAGENT_DEFAULTS.sessionPrompt],
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
    if (instructionText(INSTRUCTION_KEYS.oversight) === text) return
    await putInstruction(INSTRUCTION_KEYS.oversight, text)
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
    if (!collabOn()) return
    if (!session()) return
    void writeOversightInstruction(rootOversight()).catch(() => {})
  })

  /** The assignment prompt always starts with the report protocol. */
  createEffect(() => {
    const id = rootSessionID()
    if (!id) return
    if (!collabOn()) return
    if (!root().initialized[id]) return
    if (instructionText(INSTRUCTION_KEYS.assignmentPrompt) === assignmentPromptEntry()) return
    void putInstruction(INSTRUCTION_KEYS.assignmentPrompt, assignmentPromptEntry()).catch(() => {})
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
    decorate(value, root(), rootNode.model, names())
    value.title = rootTitle()
    return value
  })

  const appliedDefaults = new Set<string>()
  createEffect(() => {
    const current = session()
    if (!current) return
    const scoped = root()
    if (scoped.defaultPolicy !== "fixed") return
    const model = scoped.defaultModel
    const since = scoped.defaultSetAt
    if (!model || since === undefined) return
    const family = new Set(props.context.data.session.family(current.id))
    for (const item of sessions()) {
      if (item.id === current.id || !family.has(item.id)) continue
      if ((item.time?.created ?? 0) <= since) continue
      if (scoped.policies[item.id] && scoped.policies[item.id] !== "fixed") continue
      if (appliedDefaults.has(item.id)) continue
      appliedDefaults.add(item.id)
      if (item.model && sameModel(item.model, model)) continue
      void props.context.client.session
        .switchModel({
          sessionID: item.id,
          model: { providerID: model.providerID, id: model.id },
        })
        .catch(() => {})
    }
  })

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

  /** 协作模式总开关：1s 轮询一次带短缓存的读取，外部改动最迟 5s 生效。 */
  const [collabOn, setCollabOn] = createSignal(readCollabEnabled())
  const collabClock = setInterval(() => setCollabOn(readCollabEnabled()), 1_000)
  onCleanup(() => clearInterval(collabClock))

  async function setCollabEnabled(enabled: boolean) {
    await writeCollabSwitch(enabled)
    setCollabOn(enabled)
    props.context.ui.toast.show({ message: enabled ? "agents协作已启用。" : "agents协作已停用。" })
  }

  /** 一行的状态。root 行不带时长。 */
  const rowStatus = (row: FlatNode) =>
    row.node.sessionID
      ? displayStatus(props.context, row.node.sessionID, { now: now(), duration: row.node.kind !== "root" })
      : { glyph: "○", text: "等待中", longRunning: false }

  /** 标题行的前缀：层级缩进，加上折叠箭头（有子节点时）。 */
  const rowPrefix = (row: FlatNode) => "  ".repeat(row.depth) + (row.hasChildren ? (row.expanded ? "▼ " : "▶ ") : "")

  /** 标题文字的起始列：前缀之后留给状态图标与空格。 */
  const titleColumn = (row: FlatNode) => displayWidth(rowPrefix(row)) + 2

  /** 第一行：状态图标加标题；标题过长时单行省略号截断。 */
  const rowTitle = (row: FlatNode) => {
    const prefix = `${rowStatus(row).glyph} `
    const locked =
      row.node.kind === "subagent" && row.node.sessionID && root().keptSubagents?.[row.node.sessionID] ? " 🔒" : ""
    const room = Math.max(1, panelWidth() - titleColumn(row) - displayWidth(locked))
    return `${prefix}${truncate(row.node.title, room)}${locked}`
  }

  /** 一行的模型名：全名，不省略。 */
  const rowModel = (row: FlatNode) =>
    row.node.kind === "root"
      ? rootModelLabel(row.node.model)
      : modelLabel(row.node.model, autoModels().length > 0) || "设置模型…"

  /** 一行的徽标：跟随默认只写等级，用户固定过的写全。 */
  const rowBadge = (row: FlatNode) => {
    const contract = oversightFor(row.node.sessionID ?? rootSessionID())
    if (row.node.kind === "root") return `监管 L${contract.level} ${contract.name}`
    if (contract.source === "pin") return `监管 L${contract.level} ${contract.name}`
    return `L${contract.level}`
  }

  /** 子代理的上下文读数：最近一次 assistant 调用的输入规模，无数据时整段不显示。 */
  const rowUsage = (row: FlatNode) =>
    row.node.kind === "subagent" && row.node.sessionID
      ? contextUsageView(props.context.data.session.message.list(row.node.sessionID))
      : undefined

  /**
   * 第二行：状态 · 模型全名 · token 用量 · 徽标。
   * 模型名永不省略：状态与模型放不下时模型自己换行，用量与徽标放不下时另起一行。
   * 状态段单独返回，便于长时运行时给它上警示色。
   */
  const rowInfo = (row: FlatNode) => {
    const indent = " ".repeat(titleColumn(row))
    const view = row.node.kind === "root" ? undefined : rowStatus(row)
    const status = view?.text ?? ""
    const model = rowModel(row)
    const badge = rowBadge(row)
    const usage = rowUsage(row)
    const usageText = usage ? `${usage.text}${usage.warning ? " ⚠" : ""}` : undefined
    const room = Math.max(MIN_CONTENT_WIDTH, panelWidth() - displayWidth(indent))
    const head = status ? `${status}${SEPARATOR}${model}` : model
    const oneLine = displayWidth(head) <= room
    const stacked = Boolean(status) && !oneLine
    const tail = [usageText, badge].filter(Boolean).join(SEPARATOR)
    const inline = oneLine && displayWidth(head) + displayWidth(`${SEPARATOR}${tail}`) <= room
    return {
      status: status ? `${indent}${status}` : undefined,
      statusWarning: view?.longRunning ?? false,
      model: status && !stacked ? `${SEPARATOR}${model}` : `${indent}${model}`,
      stacked,
      usage: usageText ? (inline ? `${SEPARATOR}${usageText}` : `${indent}${usageText}`) : undefined,
      usageWarning: usage?.warning ?? false,
      badge: inline || usageText ? `${SEPARATOR}${badge}` : `${indent}${badge}`,
      ownLine: !inline,
    }
  }

  /** 一行标题的颜色：长时间运行用告警色，运行中用强调色，结束态与等待中淡化。 */
  const titleColor = (row: FlatNode) => {
    const status = rowStatus(row)
    if (status.longRunning) return warningColor()
    if (status.glyph === "●") return accentColor()
    return theme.text.muted
  }

  /** 徽标的颜色：用户固定过的等级正常亮色，跟随默认的等级淡化。 */
  const badgeColor = (row: FlatNode) => {
    if (row.node.kind === "root") return theme.text.muted
    const contract = oversightFor(row.node.sessionID ?? rootSessionID())
    return contract.source === "pin" ? theme.text.base : theme.text.muted
  }

  const policyChoice = (node: AgentNode): ModelChoice | undefined => {
    if (!node.sessionID) return undefined
    const policy = root().policies[node.sessionID] ?? root().defaultPolicy ?? "inherit"
    if (policy === "auto") return { kind: "auto" }
    if (policy === "inherit") return { kind: "inherit" }
    const actual = node.model?.actual ?? root().defaultModel
    if (!actual) return undefined
    const model = models().find((item) => item.providerID === actual.providerID && item.id === actual.id)
    return model ? { kind: "model", model } : undefined
  }

  async function toggleFavorite(model: ModelInfo) {
    const enabled = !preferences().favorite.some(
      (item) => item.providerID === model.providerID && item.modelID === model.id,
    )
    setPreferences(
      await updateModelPreference(preferencePath, (current) => ({
        favorite: favoriteModels({ providerID: model.providerID, modelID: model.id }, current.favorite, enabled),
      })),
    )
    props.context.ui.toast.show({ message: enabled ? `已收藏 ${model.name || model.id}。` : `已取消收藏 ${model.name || model.id}。` })
  }

  async function configureAutoModels() {
    const options = [
      ...models().map((model) => ({
        value: { kind: "toggle" as const, model },
        title: `${autoModels().some((item) => sameModel(item, model)) ? "✓" : "○"} ${model.name || model.id}`,
        description: `${model.providerID}/${model.id} · ${autoModels().some((item) => sameModel(item, model)) ? "移除" : "加入"}全局自动模型`,
      })),
      { value: { kind: "done" as const }, title: "完成", description: "所有 Session 共用这份列表" },
    ]
    if (!options.some((option) => option.value.kind === "toggle")) {
      props.context.ui.toast.show({ message: "当前项目没有可用模型。" })
      return
    }
    const picked = await props.context.ui.dialog.select<{ kind: "toggle"; model: ModelInfo } | { kind: "done" }>({
      title: "全局自动模型",
      placeholder: "选择 Superagent 可以自动分配的模型",
      options,
    })
    if (!picked || picked.kind === "done") return
    const model = picked.model
    await updateGlobal((draft) => {
      const current = (draft.autoModels ?? []) as ModelRef[]
      const exists = current.some((item) => sameModel(item, model))
      draft.autoModels = exists
        ? current.filter((item) => !sameModel(item, model))
        : [...current, { providerID: model.providerID, id: model.id }]
    })
    return configureAutoModels()
  }

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

  /** 头部第三行：监管等级与等级名。 */
  const oversightText = createMemo(() => {
    const contract = rootOversight()
    return headerLine("监管", `L${contract.level} ${contract.name}`)
  })

  /** 头部文字也按可用宽度收尾，窄栏下不会换行。 */
  const headerText = (text: string) => truncate(text, Math.max(MIN_CONTENT_WIDTH, panelWidth()))

  /** Native /models when the host exposes it; the bundled picker is the fallback. */
  async function pickModel(title: string, current?: { providerID: string; id: string }) {
    // `ui.model.select` is the official native /models entry. OpenCode 2.2.5's
    // shipped TUI predates it, so older hosts still hit the bundled picker below.
    const native = props.context.ui.model?.select
    if (typeof native === "function") {
      const selected = await native({ title })
      if (!selected) return
      const info = models().find((item) => item.providerID === selected.providerID && item.id === selected.modelID)
      return {
        model: info ?? ({ providerID: selected.providerID, id: selected.modelID, name: selected.modelID } as ModelInfo),
        providerID: selected.providerID,
        id: selected.modelID,
        variant: selected.variant,
      }
    }
    await loadPreferences()
    const picked = await new Promise<ModelInfo | undefined>((resolve) => {
      let settled = false
      const done = (value: ModelInfo | undefined) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      props.context.ui.dialog.show(
        () => (
          <ModelPicker
            context={props.context}
            title={title}
            groups={pickerGroups}
            favorites={pickerFavorites}
            providerName={providerName}
            current={current}
            onFavorite={(model) => void toggleFavorite(model)}
            onSelect={(model) => {
              done(model)
              props.context.ui.dialog.clear()
            }}
            onClose={() => done(undefined)}
          />
        ),
        () => done(undefined),
      )
    })
    if (!picked) return
    return { model: picked, providerID: picked.providerID, id: picked.id, variant: preferences().variant[pickerKey(picked)] }
  }

  async function applyDefaultModel(model: ModelInfo, variant?: string) {
    await updateRoot((draft) => {
      draft.defaultPolicy = "fixed"
      draft.defaultModel = { providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) }
      draft.defaultSetAt = Date.now()
    })
    await putInstruction(INSTRUCTION_KEYS.defaultModel, `${model.providerID}/${model.id}`)
    await rememberRecent(model)
    props.context.ui.toast.show({
      message: `子代理默认模型已设为 ${model.name || model.id}。`,
    })
  }

  async function openDefaults() {
    await loadPreferences()
    const scoped = root()
    const current: DefaultAction | undefined =
      scoped.defaultPolicy === "auto"
        ? { kind: "auto" }
        : scoped.defaultPolicy === "inherit"
          ? { kind: "inherit" }
          : undefined
    const selected = await props.context.ui.dialog.select<DefaultAction>({
      title: "子代理默认模型",
      options: [
        {
          value: { kind: "auto" },
          title: "自动",
          description:
            autoModels().length > 0 ? `每次分配由 Superagent 从 ${autoModels().length} 个全局自动模型中指定` : "未配置（禁用）",
          disabled: autoModels().length === 0,
        },
        { value: { kind: "inherit" }, title: "跟随会话", description: "使用当前会话的模型（Superagent 主模型）" },
        { value: { kind: "choose" }, title: "选择模型…", description: "打开原生 /models 选择器" },
        { value: { kind: "configure" }, title: "配置全局自动模型…", description: "所有 Session 共用这份列表" },
      ],
      current,
    })
    if (!selected) return
    if (selected.kind === "configure") return configureAutoModels()
    if (selected.kind === "auto") {
      await updateRoot((draft) => {
        draft.defaultPolicy = "auto"
        draft.defaultModel = undefined
        draft.defaultSetAt = undefined
      })
      props.context.ui.toast.show({ message: "子代理默认模型已设为自动。" })
      return
    }
    if (selected.kind === "inherit") {
      await updateRoot((draft) => {
        draft.defaultPolicy = "inherit"
        draft.defaultModel = undefined
        draft.defaultSetAt = undefined
      })
      props.context.ui.toast.show({ message: "子代理默认模型已设为跟随会话。" })
      return
    }
    const picked = await pickModel(
      "子代理默认模型",
      scoped.defaultPolicy === "fixed" ? scoped.defaultModel : undefined,
    )
    if (picked) await applyDefaultModel(picked.model, picked.variant)
  }

  /** 正在换模型的会话：同一时间只允许一次切换，避免两次动作交错。 */
  const switchingModels = new Set<string>()

  /**
   * 换模型：空闲时直接换；运行中先中断，等执行真的停下再换，并让子代理继续。
   * 中断失败就中止，不在半中断的状态下换模型。
   */
  async function applyModelSwitch(sessionID: string, model: ModelRef, label: string) {
    if (switchingModels.has(sessionID)) {
      props.context.ui.toast.show({ message: "正在切换模型，请稍候。" })
      return
    }
    switchingModels.add(sessionID)
    const running = isSessionRunning(props.context, sessionID)
    try {
      if (running) {
        await props.context.client.session.interrupt({ sessionID })
        const stopped = await waitForSessionIdle(props.context, sessionID)
        if (!stopped) {
          props.context.ui.toast.show({ message: "中断没有生效，模型未切换。" })
          return
        }
      }
      await props.context.client.session.switchModel({ sessionID, model })
      props.context.ui.toast.show({
        message: running ? `已中断当前步骤，切换模型 ${label} 并继续` : `已切换模型 ${label}`,
      })
      if (!running) return
      try {
        await props.context.client.session.prompt({
          sessionID,
          text: `模型已切换为 ${label}，继续当前任务`,
          delivery: "steer",
        })
      } catch {
        props.context.ui.toast.show({ message: `模型已切换为 ${label}，请手动让该子代理继续。` })
      }
    } catch (error) {
      props.context.ui.toast.show({ message: `切换模型失败：${errorText(error)}` })
    } finally {
      switchingModels.delete(sessionID)
    }
  }

  async function openModel(node: AgentNode) {
    if (node.kind === "root") return
    await loadPreferences()
    const choice = policyChoice(node)
    const current: DefaultAction | undefined =
      choice?.kind === "auto" ? { kind: "auto" } : choice?.kind === "inherit" ? { kind: "inherit" } : undefined
    const selected = await props.context.ui.dialog.select<DefaultAction>({
      title: `设置 ${node.title} 的模型`,
      options: [
        {
          value: { kind: "auto" },
          title: "自动",
          description:
            autoModels().length > 0 ? `每次分配由 Superagent 从 ${autoModels().length} 个全局自动模型中指定` : "未配置（禁用）",
          disabled: autoModels().length === 0,
        },
        { value: { kind: "inherit" }, title: "跟随会话", description: "使用当前会话的模型（Superagent 主模型）" },
        { value: { kind: "choose" }, title: "选择模型…", description: "打开原生 /models 选择器" },
        { value: { kind: "configure" }, title: "配置全局自动模型…", description: "所有 Session 共用这份列表" },
      ],
      current,
    })
    if (!selected) return
    if (selected.kind === "configure") return configureAutoModels()
    if (selected.kind === "auto") {
      await updateRoot((draft) => {
        draft.policies = { ...draft.policies, [node.sessionID!]: "auto" }
      })
      props.context.ui.toast.show({ message: `${node.title} 已设为自动；下次分配时由 Superagent 重新选择。` })
      return
    }
    if (selected.kind === "inherit") {
      await updateRoot((draft) => {
        draft.policies = { ...draft.policies, [node.sessionID!]: "inherit" }
      })
      const parent = tree()?.model?.actual
      if (parent && node.sessionID)
        await applyModelSwitch(
          node.sessionID,
          {
            providerID: parent.providerID,
            id: parent.id,
            ...(parent.variant ? { variant: parent.variant } : {}),
          },
          names().get(modelKey(parent)) ?? parent.id,
        )
      return
    }
    const picked = await pickModel(`设置 ${node.title} 的模型`, node.model?.actual)
    if (!picked) return
    const modelRef = {
      providerID: picked.providerID,
      id: picked.id,
      ...(picked.variant ? { variant: picked.variant } : {}),
    }
    const oversight = oversightFor(node.sessionID!)
    await updateRoot((draft) => {
      draft.policies = { ...draft.policies, [node.sessionID!]: "fixed" }
    })
    await applyModelSwitch(node.sessionID!, modelRef, picked.model.name || picked.model.id)
    await rememberRecent(picked.model)
    void appendOversightEvent("model.changed", {
      rootSessionID: rootSessionID(),
      sessionID: node.sessionID,
      oversight: { level: oversight.level, source: oversight.source },
    }).catch(() => {})
  }

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
            ? "已启用 · 关闭后拦截、切换、复核、探针全部停止"
            : "已停用 · 面板只留一行，左键可重新开启",
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
    if (selected.kind === "assignmentPrompt") return editAssignmentPrompt()
    if (selected.kind === "taskPrompt") return editTaskPrompt()
    if (selected.kind === "restore") return restoreDefaults()
    if (selected.kind === "defaults") return openDefaults()
    if (selected.kind === "fallbackModel") return editFallbackModel("superagent")
    if (selected.kind === "subagentFallbackModel") return editFallbackModel("subagent")
    if (selected.kind === "fallbackEnabled") return editFallbackEnabled()
    if (selected.kind === "criticEnabled") return editCriticEnabled()
    return configureAutoModels()
  }

  async function recreateSubagent(node: AgentNode) {
    if (!node.sessionID) return
    const current = props.context.data.session.get(node.sessionID)
    if (!current) return
    const confirmed = await props.context.ui.dialog.confirm({
      title: "删除并重建",
      message: `删除并重建 ${node.title}？上下文将被清空。`,
      label: { confirm: "删除并重建", cancel: "取消" },
    })
    if (!confirmed) return
    const prompt = latestUserMessage(props.context, node.sessionID) ?? current.title ?? node.title
    // 交接摘要取不到（读会话失败）不阻塞删除重建，降级为无交接直接重建。
    const handoff = await buildHandoffSummary({
      client: props.context.client as unknown as HandoffClient,
      childSessionID: node.sessionID,
    }).catch(() => undefined)
    await props.context.client.session.remove({ sessionID: node.sessionID })
    const created = await props.context.client.session.create({
      parentID: current.parentID,
      agent: current.agent,
      model: current.model,
      title: current.title,
    })
    const brief = handoff ? `# 交接摘要\n${handoff}\n\n${prompt}` : prompt
    await props.context.client.session.prompt({ sessionID: created.id, text: brief })
    props.context.ui.toast.show({ message: `${node.title} 已清空上下文并重建。` })
  }

  async function compactSubagent(node: AgentNode) {
    if (!node.sessionID) return
    await props.context.client.session.compact({ sessionID: node.sessionID })
    props.context.ui.toast.show({ message: `已请求压缩 ${node.title} 的上下文。` })
  }

  /** Protects a Subagent from automatic eviction. Manual deletion stays allowed. */
  async function toggleKeep(node: AgentNode) {
    const sessionID = node.sessionID
    if (!sessionID) return
    const kept = Boolean(root().keptSubagents?.[sessionID])
    const next = { ...root().keptSubagents }
    if (kept) delete next[sessionID]
    else next[sessionID] = true
    await updateRoot((draft) => {
      draft.keptSubagents = next
    })
    await writeKeptEntry(next).catch(() => {})
    props.context.ui.toast.show({
      message: kept ? `${node.title} 已取消保护，可被自动淘汰。` : `${node.title} 已保护，不会被自动淘汰。`,
    })
  }

  /** Sessions whose removal is already running; they are never deleted twice. */
  const evicting = new Set<string>()
  let pruning = false
  let pruneAgain = false

  /**
   * Keeps the number of Subagents under the limit. The oldest finished
   * Subagent goes first; running, protected, pending and currently viewed
   * sessions stay.
   */
  async function evictExcessSubagents() {
    if (pruning) {
      pruneAgain = true
      return
    }
    pruning = true
    try {
      do {
        pruneAgain = false
        const limit = subagentLimit()
        const children = directSubagents()
        if (children.length <= limit) break
        const scoped = root()
        const plan = planEviction({
          children: children.map(
            (item): SubagentChild => ({
              id: item.id,
              title: subagentTitle(item),
              status: String(props.context.data.session.status(item.id)),
              outcome: item.outcome,
              created: item.time?.created,
              updated: item.time?.updated,
            }),
          ),
          limit,
          currentSessionID: props.sessionID,
          keptSubagents: scoped.keptSubagents,
        })
        const victims = plan.victims.filter((victim) => !evicting.has(victim.id))
        if (victims.length === 0) break
        for (const victim of victims) {
          evicting.add(victim.id)
          try {
            await props.context.client.session.remove({ sessionID: victim.id })
            props.context.ui.toast.show({
              message: `已自动淘汰子代理「${victim.title}」(${victim.id})：超出上限 ${limit}，已删除最旧的已完成子代理。`,
            })
            void appendOversightEvent("subagent.evicted", {
              rootSessionID: rootSessionID(),
              sessionID: victim.id,
              title: victim.title,
              limit,
            }).catch(() => {})
          } catch {
            // The session stays; a later prune tries again.
          } finally {
            evicting.delete(victim.id)
          }
        }
      } while (pruneAgain)
    } finally {
      pruning = false
    }
  }
  createEffect(() => {
    if (!ready()) return
    if (!collabOn()) return
    directSubagents().length
    subagentLimit()
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
        { value: { kind: "compact" }, title: "压缩上下文", description: "请求压缩该子代理的上下文" },
        {
          value: { kind: "keep" },
          title: kept ? "取消保护" : "保护此子代理",
          description: kept ? "允许自动淘汰这个子代理" : "禁止自动淘汰这个子代理",
        },
        { value: { kind: "recreate" }, title: "删除并重建", description: "清空上下文后按原配置重新创建" },
      ],
    })
    if (!selected) return
    if (selected.kind === "model") return openModel(node)
    if (selected.kind === "compact") return compactSubagent(node)
    if (selected.kind === "keep") return toggleKeep(node)
    if (selected.kind === "recreate") return recreateSubagent(node)
    if (node.sessionID) props.context.ui.router.navigate({ type: "session", sessionID: node.sessionID })
  }

  return (
    <Show
      when={collabOn()}
      fallback={
        <box id="sidebar.agents" flexDirection="column">
          <text
            id="sidebar.agents.disabled"
            fg={theme.text.muted}
            onMouseUp={(event) => {
              if (event.button !== 0) return
              void setCollabEnabled(true)
            }}
          >
            agents协作已停用 · 左键开启
          </text>
        </box>
      }
    >
      <Show when={tree()}>
      {(value) => (
        <box
          id="sidebar.agents"
          flexDirection="column"
          onSizeChange={function () {
            setMeasuredWidth(this.width)
          }}
        >
          <box flexDirection="column" gap={0}>
            <text
              id="sidebar.agents.settings"
              fg={theme.text.base}
              onMouseUp={(event) => {
                if (event.button !== 0) return
                void openSettings()
              }}
            >
              <b>agents协作</b>
            </text>
            <text
              id="sidebar.agents.default"
              fg={theme.text.muted}
              onMouseUp={(event) => {
                if (event.button !== 0) return
                void openDefaults()
              }}
            >
              {headerText(defaultLabel())}
            </text>
            <text
              id="sidebar.agents.count"
              fg={subagentOverLimit() ? (theme.text.feedback?.warning?.base ?? theme.text.muted) : theme.text.muted}
              onMouseUp={(event) => {
                if (event.button !== 0) return
                void openOversightAudit()
              }}
            >
              {headerText(subagentCountText())}
            </text>
            <text
              id="sidebar.agents.oversight"
              fg={theme.text.muted}
              onMouseUp={(event) => {
                if (event.button !== 0) return
                void openOversight()
              }}
            >
              {headerText(oversightText())}
            </text>
          </box>
          <For each={rows()}>
            {(row) => (
              <box id={`sidebar.agents.row.${row.node.id}`} flexDirection="column">
                <box flexDirection="row" gap={0}>
                  <text
                    id={`sidebar.agents.toggle.${row.node.id}`}
                    fg={theme.text.base}
                    onMouseUp={(event) => {
                      if (event.button !== 0) return
                      if (row.hasChildren) setExpanded(row.node.id, !row.expanded)
                    }}
                  >
                    {rowPrefix(row)}
                  </text>
                  <text
                    id={`sidebar.agents.title.${row.node.id}`}
                    fg={titleColor(row)}
                    onMouseUp={(event) => {
                      if (event.button !== 0) return
                      if (row.node.kind === "subagent") void openActions(row.node)
                    }}
                  >
                    {rowTitle(row)}
                  </text>
                </box>
                <Show when={row.node.kind === "subagent" || row.node.model}>
                  <box flexDirection="row" gap={0}>
                    <box flexDirection={rowInfo(row).stacked ? "column" : "row"} gap={0}>
                      <Show when={rowInfo(row).status}>
                        {(status) => (
                          <text
                            id={`sidebar.agents.status.${row.node.id}`}
                            fg={rowInfo(row).statusWarning ? warningColor() : theme.text.muted}
                            flexShrink={0}
                          >
                            {status()}
                          </text>
                        )}
                      </Show>
                      <text
                        id={`sidebar.agents.model.${row.node.id}`}
                        fg={theme.text.muted}
                        wrapMode="word"
                        flexShrink={1}
                        onMouseUp={(event) => {
                          if (event.button !== 0) return
                          if (row.node.kind === "root") return
                          event.stopPropagation()
                          void openModel(row.node)
                        }}
                      >
                        {rowInfo(row).model}
                      </text>
                    </box>
                    <Show when={!rowInfo(row).ownLine}>
                      <Show when={rowInfo(row).usage}>
                        {(usage) => (
                          <text
                            id={`sidebar.agents.usage.${row.node.id}`}
                            fg={rowInfo(row).usageWarning ? warningColor() : theme.text.muted}
                            flexShrink={0}
                          >
                            {usage()}
                          </text>
                        )}
                      </Show>
                      <text
                        id={`sidebar.agents.badge.${row.node.id}`}
                        fg={badgeColor(row)}
                        flexShrink={0}
                        onMouseUp={(event) => {
                          if (event.button !== 0) return
                          if (row.node.kind !== "subagent") return
                          event.stopPropagation()
                          void openSubagentOversight(row.node)
                        }}
                      >
                        {rowInfo(row).badge}
                      </text>
                    </Show>
                  </box>
                  <Show when={rowInfo(row).ownLine}>
                    <box flexDirection="row" gap={0}>
                      <Show when={rowInfo(row).usage}>
                        {(usage) => (
                          <text
                            id={`sidebar.agents.usage.${row.node.id}`}
                            fg={rowInfo(row).usageWarning ? warningColor() : theme.text.muted}
                            flexShrink={0}
                          >
                            {usage()}
                          </text>
                        )}
                      </Show>
                      <text
                        id={`sidebar.agents.badge.${row.node.id}`}
                        fg={badgeColor(row)}
                        flexShrink={0}
                        onMouseUp={(event) => {
                          if (event.button !== 0) return
                          if (row.node.kind !== "subagent") return
                          event.stopPropagation()
                          void openSubagentOversight(row.node)
                        }}
                      >
                        {rowInfo(row).badge}
                      </text>
                    </box>
                  </Show>
                </Show>
                <Show when={row.node.kind === "subagent" ? criticRecord(row.node.sessionID) : undefined}>
                  {(record) => (
                    <box flexDirection="row" gap={0}>
                      <text
                        id={`sidebar.agents.critic.${row.node.id}`}
                        fg={criticColor(record())}
                        onMouseUp={(event) => {
                          if (event.button !== 0) return
                          event.stopPropagation()
                          void openCritic(row.node, record())
                        }}
                      >
                        {`${criticIndent(row)}${criticView(record().verdict).text}`}
                      </text>
                    </box>
                  )}
                </Show>
              </box>
            )}
          </For>
          <Show when={value().children.length === 0}>
            <text fg={theme.text.muted}>暂无子代理，分配任务后显示</text>
          </Show>
        </box>
      )}
      </Show>
    </Show>
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