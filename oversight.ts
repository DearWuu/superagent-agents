export type OversightLevel = 0 | 1 | 2 | 3 | 4
export type OversightRisk = "low" | "normal" | "high" | "critical"
export type OversightSource = "default" | "pin"

/**
 * The structured status a report declares in its header. The Superagent
 * reads the task state from this marker only; it never infers "waiting for
 * a human" from the free text of a report.
 */
export type ReportStatus = "progress" | "blocked" | "ready" | "failed"

export const REPORT_STATUS_VALUES = ["progress", "blocked", "ready", "failed"] as const

/** Inline budget of the dispatch task brief, in characters. */
export const TASK_BRIEF_INLINE_LIMIT = 1500

/** Inline budget of a single command output inside a report, in characters. */
export const COMMAND_OUTPUT_INLINE_LIMIT = 600

/**
 * The report contract a Subagent receives. It never restricts what the
 * Subagent may do; it only fixes how much of the work has to be reported
 * back to the Superagent.
 */
export type OversightContract = {
  level: OversightLevel
  source: OversightSource
  /** 结果级 / 摘要级 / 证据级 / 全量级 / 审计级 */
  name: string
  /** The report sections the Subagent must deliver, in order. */
  sections: readonly string[]
  /** When the Subagent reports back. */
  cadence: string
}

export type OversightModel = {
  providerID: string
  id: string
  name?: string
  cost?: ReadonlyArray<{ input: number; output?: number }>
  capability?: number
  price?: number
  description?: string
  free?: boolean
}

/**
 * Pins hold levels (0-4). Legacy settings wrote scores (0-100); numeric
 * values above 4 are read through the old score bands.
 */
export type OversightPins = {
  global?: number
  models?: Record<string, number>
  sessions?: Record<string, number>
}

export type ResolveOversightInput = {
  model?: OversightModel
  rootSessionID?: string
  sessionID?: string
  taskRisk?: OversightRisk
  pins?: OversightPins
}

export const DEFAULT_OVERSIGHT_LEVEL: OversightLevel = 2

/** The report tier names shown in the level picker. */
export const OVERSIGHT_LEVEL_NAMES: Record<OversightLevel, string> = {
  0: "结果级",
  1: "摘要级",
  2: "证据级",
  3: "全量级",
  4: "审计级",
}

const L0_SECTIONS = [
  "改动：文件清单，每个一句话",
  "测试：命令 + 结论",
  "风险：遗留风险与未解决项",
] as const

const L1_SECTIONS = [
  ...L0_SECTIONS,
  "执行：命令清单 + exit code",
  "阶段小结：每阶段一段",
] as const

const FAILURE_DETAIL_SECTION = "失败详情：失败命令的关键输出"

const L2_SECTIONS = [
  ...L1_SECTIONS.map((section) => (section.startsWith("测试：") ? "测试：命令 + 结果明细" : section)),
  "阅读：读过的文件 path:行号 + 目的",
  FAILURE_DETAIL_SECTION,
] as const

const L3_SECTIONS = [
  ...L2_SECTIONS,
  "命令完整输出：关键命令的完整输出（合理截断）",
  "关键代码摘录：改动相关的关键代码",
  "每文件修改理由：每个文件为什么这么改",
] as const

const L4_SECTIONS = [
  ...L3_SECTIONS,
  "每步动机：每一步为什么这么做",
  "假设清单：本次依赖的假设",
  "考虑过又放弃的方案：备选方案与放弃原因",
] as const

/** How often the Subagent reports back. Only the report cadence changes. */
const CADENCES: Record<OversightLevel, string> = {
  0: "完成或失败/阻塞时交一次结构化报告，必填章节：",
  1: "完成或失败/阻塞时交一次结构化报告，必填章节：",
  2: "完成或失败/阻塞时交一次结构化报告，必填章节：",
  3: "结束时交全量报告，每文件/阶段完成时中途简报，必填章节：",
  4: "每步汇报，结束时交总报告，必填章节：",
}

const SECTIONS: Record<OversightLevel, readonly string[]> = {
  0: L0_SECTIONS,
  1: L1_SECTIONS,
  2: L2_SECTIONS,
  3: L3_SECTIONS,
  4: L4_SECTIONS,
}

/** The report header every level has to carry, in a fixed order. */
const REPORT_HEADER_INTRO =
  "报告头部固定三行（Superagent 只按这三行判断状态，不从自由文本推断是否在等人）："

const REPORT_HEADER_LINES = [
  `状态：${REPORT_STATUS_VALUES.join(" | ")}（progress=还在推进；blocked=等人或等外部条件；ready=完成待验收；failed=失败）`,
  "需人决定：blocked 时必填，一个具体问句；非 blocked 写“无”",
  "报告时间：ISO 时间戳（如 2026-01-01T00:00:00Z）",
] as const

/** Heartbeat cadence that applies to every level; the full report still follows the protocol. */
const HEARTBEAT_LINE =
  "长任务心跳：预计超 10 分钟的任务，每约 10 分钟用一行进度（当前步骤/已完成/剩余）向 Superagent 简报一次，完整报告仍按协议交付。"

/** Inline budgets; anything longer travels as a pointer, not as inline text. */
const BUDGET_LINE = `预算（内联+指针）：派工任务书内联上限 ${TASK_BRIEF_INLINE_LIMIT} 字，超出部分放文件/消息并在任务书里给指针；报告中单条命令输出内联上限 ${COMMAND_OUTPUT_INLINE_LIMIT} 字，超出给 path:行号 或日志文件指针，不整段粘贴。`

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * Legacy score bands. Only used to read score data written by older versions:
 * 58 still maps to L2 and 70 to L3. New code stores levels directly.
 */
export function oversightLevel(score: number): OversightLevel {
  if (!Number.isFinite(score)) return DEFAULT_OVERSIGHT_LEVEL
  return clamp(Math.floor(score / 20), 0, 4) as OversightLevel
}

/** A stored pin is a level (0-4); anything above 4 is a legacy score. */
export function oversightLevelForPin(value: number): OversightLevel {
  if (!Number.isFinite(value)) return DEFAULT_OVERSIGHT_LEVEL
  if (value <= 4) return clamp(Math.round(value), 0, 4) as OversightLevel
  return oversightLevel(value)
}

export function modelKey(model: Pick<OversightModel, "providerID" | "id">) {
  return `${model.providerID}/${model.id}`
}

function words(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Pure model-name heuristic. Kept for callers that derive levels explicitly;
 * the task orchestrator does not use it in its default path.
 */
export function capabilityFromName(name: string | undefined) {
  if (!name) return 50
  const tokens = new Set(words(name))
  const has = (value: string) => tokens.has(value)
  if (["opus", "ultra", "reasoning", "max", "o3", "o4"].some(has)) return 88
  if (["flash", "mini", "lite", "small", "haiku", "nano"].some(has)) return 35
  if (["sonnet", "plus", "standard", "turbo"].some(has)) return 60
  if (["free", "local"].some(has)) return 28
  return 50
}

/**
 * Pure price heuristic. Not part of the default orchestrator path.
 */
export function priceScoreFor(model: OversightModel | undefined) {
  if (!model) return 50
  if (model.price !== undefined) return clamp(Math.round(model.price), 0, 100)
  if (model.cost?.length) {
    const input = model.cost.reduce((total, cost) => total + cost.input, 0)
    if (input === 0) return 0
  }
  if (isFreeModel(model)) return 0
  return 50
}

/**
 * Pure history heuristic. Not part of the default orchestrator path.
 */
export function reliabilityFor(history?: { n: number; success: number; severe: number }) {
  if (!history || history.n < 3) return { n: history?.n ?? 0, R: 75, delta: 0 }
  const R = Math.round((history.success + 6) / (history.n + 8))
  return { n: history.n, R, delta: Math.round(R - 75) }
}

export function isFreeModel(model: OversightModel): boolean {
  if (model.free === true) return true
  if (mentionsFree(model.name)) return true
  if (mentionsFree(model.id)) return true
  if (mentionsFree(model.description)) return true
  if (mentionsFree(model.providerID)) return true
  return false
}

function mentionsFree(value: string | undefined) {
  if (!value) return false
  return words(value).includes("free")
}

/**
 * The report detail level. It defaults to L2 (证据级) unless a user pin
 * says otherwise; model capability, price, history and task risk never move
 * the level on their own.
 */
export function resolveOversight(input: ResolveOversightInput = {}): OversightContract {
  const sessionPin = input.sessionID ? input.pins?.sessions?.[input.sessionID] : undefined
  const rootPin =
    input.rootSessionID && input.rootSessionID !== input.sessionID
      ? input.pins?.sessions?.[input.rootSessionID]
      : undefined
  const modelPin = input.model ? input.pins?.models?.[modelKey(input.model)] : undefined
  const pin = sessionPin ?? rootPin ?? modelPin ?? input.pins?.global
  const level = pin === undefined ? DEFAULT_OVERSIGHT_LEVEL : oversightLevelForPin(pin)
  const source: OversightSource = pin === undefined ? "default" : "pin"
  return {
    level,
    source,
    name: OVERSIGHT_LEVEL_NAMES[level],
    sections: SECTIONS[level],
    cadence: CADENCES[level],
  }
}

export function oversightLabel(contract: Pick<OversightContract, "level">) {
  return `L${contract.level}`
}

/**
 * The report protocol injected into the assignment prompt. It never limits
 * the Subagent's behavior; it only fixes the required report sections and
 * states that the evidence has to be real.
 */
export function renderReportProtocol(contract: OversightContract) {
  return [
    `[报告协议 ${oversightLabel(contract)} · ${contract.name}]`,
    contract.cadence,
    HEARTBEAT_LINE,
    REPORT_HEADER_INTRO,
    ...REPORT_HEADER_LINES,
    ...contract.sections.map((section) => `- ${section}`),
    "说明：行为不受限制；证据必须真实（真实执行输出、真实文件引用）；Superagent 可随时翻查 session 完整记录核查。",
    BUDGET_LINE,
  ].join("\n")
}
