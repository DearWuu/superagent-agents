/** TUI 面板的指令 key、默认提示词与报告样式等静态配置。 */

import { DEFAULT_MAX_FLAGSHIP_SUBAGENTS } from "./flagship"
import type { ModelRef } from "./model-policy"
import type { OversightLevel } from "./oversight"
import type { Policy } from "./panel-types"

export const INSTRUCTION_KEYS = {
  collabEnabled: "superagent.collab-enabled",
  reportStyle: "superagent.report-style",
  sessionPrompt: "superagent.session-prompt",
  taskPrompt: "superagent.task-prompt",
  maxSubagents: "superagent.max-subagents",
  maxFlagshipSubagents: "superagent.max-flagship-subagents",
  oversight: "superagent.oversight",
  oversightLevel: "superagent.oversight-level",
  assignmentPrompt: "superagent.assignment-prompt",
  defaultModel: "superagent.default-model",
  fallbackModel: "superagent.fallback-model",
  subagentFallbackModel: "superagent.subagent-fallback-model",
  fallbackThreshold: "superagent.fallback-threshold",
  fallbackEnabled: "superagent.fallback-enabled",
  criticEnabled: "superagent.critic-enabled",
  statusWatch: "superagent.status-watch",
  keptSubagents: "superagent.kept-subagents",
} as const

/** 各级监管的实现程度：选择器里介绍"管到什么程度"与验收深度，不写操作说明。 */
export const OVERSIGHT_LEVEL_DESCRIPTIONS: Record<OversightLevel, string> = {
  0: "只交结果：改动/测试/风险，完成时一次汇报 · 结果验收（低风险）",
  1: "加命令清单与阶段小结，完成时一次汇报 · 摘要验收（常规）",
  2: "加阅读记录与失败详情，证据可核查（默认） · 证据验收（默认）",
  3: "加完整输出与代码摘录，每阶段中途简报 · 全量验收（严格）",
  4: "逐步汇报动机与假设，全程可审计 · 审计验收（独立 critic）",
}

/** The texts written by earlier releases; rewritten once when still the entry value. */
export const LEGACY_SESSION_PROMPTS = [
  [
    "主代理（Superagent）负责：分析需求、拆解任务、方案设计（架构/接口/交互/版面等具体设计）、编写任务书与验收标准、派工和验收。设计产物由主代理产出后交给 Subagent 实现，不让 Subagent 自行决定设计方向。",
    "主代理不做具体实现：改代码、写文件、调试、测试执行交给 Subagent；只读分析（读代码/查文档/调研）主代理可自己做。",
    "派工新建与续跑：与既有子代理无关联的新任务一律新建 Subagent，避免无关上下文污染；仅同一模块/同一文件的后续修改、验收打回返工、类似任务迭代时才 steer 续跑已有子代理。续跑对象上下文较长（>300k）时先判断是否有必要保持：任务需要这些上下文则直接续跑；无必要则先 compact 再续跑。交接摘要仅用于删除重建场景，不是续跑的前置动作。",
    "验收：按报告协议逐项核查（状态三行、章节完整性、证据真实性）；排版/UI 类必须亲眼看实际渲染结果（截图）验收，不只信报告；证据不足或与 session 记录不符打回。",
  ].join("\n"),
  [
    "主代理（Superagent）负责：分析需求、拆解任务、方案设计（架构/接口/交互/版面等具体设计）、编写任务书与验收标准、派工和验收。设计产物由主代理产出后交给 Subagent 实现，不让 Subagent 自行决定设计方向。",
    "主代理不做具体实现：改代码、写文件、调试、测试执行交给 Subagent；只读分析（读代码/查文档/调研）主代理可自己做。",
    "派工前使用 superagent-orchestration 技能；先判断任务是否适合 Flash，再决定新建还是续跑：推理密度高、需求模糊或跨模块决策的工作由旗舰负责，边界清晰且可验证的工作交给 Flash。与既有子代理无关联的新任务一律新建；仅同一模块/同一文件的后续修改、验收打回返工、类似任务迭代时续跑已有子代理。",
    "能力升级或主动需要同模型时，用户已授权用原生 subagent 创建与当前 Superagent 相同 provider/model/variant 的旗舰子代理；默认上限 2 且仍受子代理总上限约束，不得绕过。",
    "失败先区分局部返工、任务书不清与能力升级；限额切换不等于能力升级。",
    "验收前使用 superagent-acceptance 技能：按报告协议逐项核查（状态三行、章节完整性、证据真实性）；排版/UI 类必须亲眼看实际渲染结果（截图）验收，不只信报告；证据不足或与 session 记录不符打回。compact 或删除重建前使用 superagent-context 技能。详细任务书格式与技能流程见对应技能，不在本提示词重复。",
  ].join("\n"),
]

export const LEGACY_TASK_PROMPT = ""

/** Provider-neutral defaults: unset means follow the session's own model. */
export const SUPERAGENT_DEFAULTS = {
  reportStyle: "concise",
  maxSubagents: 5,
  maxFlagshipSubagents: DEFAULT_MAX_FLAGSHIP_SUBAGENTS,
  defaultPolicy: "inherit" as Policy,
  defaultModel: undefined as ModelRef | undefined,
  autoModels: [] as ModelRef[],
  fallbackModel: undefined as ModelRef | undefined,
  subagentFallbackModel: undefined as ModelRef | undefined,
  fallbackThreshold: 3,
  fallbackEnabled: true,
  criticEnabled: false,
  statusWatch: true,
  sessionPrompt: [
    "主代理（Superagent）负责：分析需求、拆解任务、方案设计（架构/接口/交互/版面等具体设计）、编写任务书与验收标准、派工和验收。设计产物由主代理产出后交给 Subagent 实现，不让 Subagent 自行决定设计方向。",
    "主代理不做具体实现：改代码、写文件、调试、测试执行交给 Subagent；只读分析（读代码/查文档/调研）主代理可自己做。",
    "派工前使用 superagent-orchestration 技能；先判断任务是否适合 Flash，再决定新建还是续跑：推理密度高、需求模糊或跨模块决策的工作由旗舰负责，边界清晰且可验证的工作交给 Flash。与既有子代理无关联的新任务一律新建；仅同一模块/同一文件的后续修改、验收打回返工、类似任务迭代时续跑已有子代理。",
    "能力升级或主动需要同模型时，用户已授权用原生 subagent 创建与当前 Superagent 相同 provider/model/variant 的旗舰子代理；默认上限 2 且仍受子代理总上限约束，不得绕过。",
    "失败先区分局部返工、任务书不清与能力升级；限额切换不等于能力升级。",
    "上下文：需要继续同一任务时优先 steer 续跑或 compact，保留上下文；只有不再需要该上下文时才删除 Subagent，删除前先与用户确认。",
    "验收前使用 superagent-acceptance 技能：按报告协议逐项核查（状态三行、章节完整性、证据真实性）；排版/UI 类必须亲眼看实际渲染结果（截图）验收，不只信报告；证据不足或与 session 记录不符打回。compact 或删除 Subagent 前使用 superagent-context 技能。详细任务书格式与技能流程见对应技能，不在本提示词重复。",
  ].join("\n"),
  assignmentPrompt:
    "按任务书执行，不扩大范围；修改后运行约定验证；报告修改文件、测试命令与结果、未解决风险；需求不清先提问，不自行决定。",
  taskPrompt:
    "按任务契约执行：范围以任务书为准，需求不清先提问；完成后报告验证结果与风险；遇到能力升级先报告，不自行切换模型。",
} as const

const REPORT_STYLE_LABELS: Record<string, string> = {
  concise: "简洁",
  detailed: "详细",
  简洁: "简洁",
  详细: "详细",
}

export const normalizeReportStyle = (value: string) =>
  value === "简洁" ? "concise" : value === "详细" ? "detailed" : value
export const reportStyleLabel = (value: string) => REPORT_STYLE_LABELS[value] ?? value

export const summarize = (value: string) => (value.length > 30 ? `${value.slice(0, 29)}…` : value)

/**
 * 协作模式总开关的作用域是 root 会话本身：开关值就是该 root 的
 * `superagent.collab-enabled` 指令条目（`"true"` / `"false"`）。
 * 条目缺省、值不合法或读取失败都按启用处理，避免误配置把功能永久关死。
 */
export function collabEnabledFromInstructions(values: Readonly<Record<string, unknown>>): boolean {
  const raw = values[INSTRUCTION_KEYS.collabEnabled]
  if (typeof raw === "boolean") return raw
  if (typeof raw !== "string") return true
  return raw.trim().toLowerCase() !== "false"
}
