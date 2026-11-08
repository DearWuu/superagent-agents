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

/** How the Superagent verifies the result at a given level. */
export type OversightCriticMode = "switch" | "required"

/**
 * The acceptance contract the Superagent applies to a Subagent's report.
 * Depth follows the Subagent's resolved oversight level; no separate setting.
 */
export type OversightAcceptance = {
  /** 结果验收 / 摘要验收 / 证据验收 / 全量验收 / 审计验收 */
  name: string
  /** What the Superagent must do before accepting the result. */
  actions: readonly string[]
  /** `switch` follows the root critic switch; `required` always reviews. */
  critic: OversightCriticMode
}

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
  /** How the Superagent verifies this level's report. */
  acceptance: OversightAcceptance
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

/**
 * What the Superagent does to verify a Subagent's result at each level.
 * The levels only change acceptance depth; they never add a new user setting.
 */
export const OVERSIGHT_ACCEPTANCE: Record<OversightLevel, OversightAcceptance> = {
  0: {
    name: "结果验收",
    actions: [
      "以子代理结论为依据，低风险改动不要求过程记录",
      "确认改动范围与派工任务书一致，没有未声明的高风险改动",
      "核对测试结论；低风险改动不要求复跑",
    ],
    critic: "switch",
  },
  1: {
    name: "摘要验收",
    actions: [
      "核对命令清单与 exit code",
      "阅读阶段小结，逐段确认结果与目标一致",
      "对关键改动做抽查，不逐行复读",
    ],
    critic: "switch",
  },
  2: {
    name: "证据验收",
    actions: [
      "核对真实输出指针（path:行号 或日志文件），不接受口头复述",
      "查看关键 diff，确认改动与目标一致",
      "失败命令必须附失败输出与原因，不接受只写结论",
      "界面改动必须提供真实截图，不接受文字描述代替",
    ],
    critic: "switch",
  },
  3: {
    name: "全量验收",
    actions: [
      "复跑关键命令并核对实际输出",
      "阅读关键代码，确认实现与修改理由一致",
      "按任务书验收点执行边界与回归检查",
      "critic 复核遵循 root 的开关，不强制",
    ],
    critic: "switch",
  },
  4: {
    name: "审计验收",
    actions: [
      "独立 critic 强制复核，不依赖 critic 开关",
      "由 Superagent 结合 critic 结论与证据做最终裁决",
      "关键检查与不稳定检查重复运行，确认结果可复现",
      "完整审计命令、代码、假设与备选方案，结论冲突时按证据重新裁定",
    ],
    critic: "required",
  },
}

export function acceptanceForLevel(level: OversightLevel): OversightAcceptance {
  return OVERSIGHT_ACCEPTANCE[level] ?? OVERSIGHT_ACCEPTANCE[DEFAULT_OVERSIGHT_LEVEL]
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

/** Reading discipline while the Subagent works; applies to every level. */
const CONTEXT_DISCIPLINE_LINE =
  "上下文纪律（工作过程）：读文件先 grep 定位、再读 path:行号 片段，不整文件粘贴；命令输出超 600 字写日志文件，上下文只留结论+指针；不重复读已读内容；接近上下文窗口时先交一页交接再继续，不硬撑到 compact。"

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
    acceptance: acceptanceForLevel(level),
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
  const acceptance = contract.acceptance ?? acceptanceForLevel(contract.level)
  return [
    `[报告协议 ${oversightLabel(contract)} · ${contract.name}]`,
    contract.cadence,
    HEARTBEAT_LINE,
    REPORT_HEADER_INTRO,
    ...REPORT_HEADER_LINES,
    ...contract.sections.map((section) => `- ${section}`),
    "说明：行为不受限制；证据必须真实（真实执行输出、真实文件引用）；Superagent 可随时翻查 session 完整记录核查。",
    BUDGET_LINE,
    CONTEXT_DISCIPLINE_LINE,
    "",
    `[Superagent 验收动作 ${oversightLabel(contract)} · ${acceptance.name}]`,
    ...acceptance.actions.map((action) => `- ${action}`),
    `复核方式：${
      acceptance.critic === "required" ? "独立 critic 强制复核" : "critic 复核遵循 root 的 critic 开关"
    }`,
  ].join("\n")
}
