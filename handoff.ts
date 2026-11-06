/**
 * One-page handoff summary of a Subagent session.
 *
 * When a Subagent session is deleted and recreated, the new session cannot see
 * the old context. Instead of relying on compaction, the orchestrator pulls a
 * bounded summary out of the old session and injects it into the new task
 * brief: title, the last report's status lines, what changed, what is left and
 * the pointers needed to look up the full record.
 *
 * Every external call is fail-safe: a failed session read, a failed message
 * list or an unexpected payload degrades to a minimal summary (title +
 * sessionID + how to look the record up) and never throws.
 */

/** Hard cap of a handoff summary, in characters. */
export const HANDOFF_LIMIT = 1000

/** Placeholder used when the session never reported a structured status. */
export const HANDOFF_NO_REPORT = "未报告"

/** Placeholder used when no changed-file detail could be extracted. */
export const HANDOFF_SEE_RECORD = "见会话记录"

/** Replacement for the completed section when the summary has to be cut. */
export const HANDOFF_COMPRESSED_COMPLETED = "已压缩，见原会话记录"

export type HandoffSessionInfo = {
  readonly title?: string
}

/** The message list, in either the bare-array or the `{ data }` shape. */
export type HandoffMessageList = readonly unknown[] | { readonly data?: readonly unknown[] }

type HandoffLister = (input: {
  readonly sessionID: string
  readonly limit?: number
}) => Promise<HandoffMessageList>

/** The slice of the OpenCode client this module uses. */
export type HandoffClient = {
  readonly session?: {
    readonly get?: (input: { readonly sessionID: string }) => Promise<HandoffSessionInfo | undefined>
    /** Kept as a fallback for clients that nest message listing under session. */
    readonly message?: { readonly list?: HandoffLister }
  }
  /** The generated client puts message listing at the top level. */
  readonly message?: { readonly list?: HandoffLister }
}

/** The rendered pieces of a handoff summary. */
export type HandoffFields = {
  readonly title: string
  readonly status: string
  readonly completed: string
  readonly remaining: string
  readonly pointers: string
}

export type BuildHandoffInput = {
  readonly client: HandoffClient
  /** The Subagent session the summary is taken from. */
  readonly childSessionID: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function readText(record: Record<string, unknown> | undefined): string {
  if (!record) return ""
  const chunks: string[] = []
  if (typeof record.text === "string" && record.text.trim()) chunks.push(record.text.trim())
  const parts = Array.isArray(record.content)
    ? record.content
    : Array.isArray(record.parts)
      ? record.parts
      : []
  for (const part of parts) {
    const text = asRecord(part)?.text
    if (typeof text === "string" && text.trim()) chunks.push(text.trim())
  }
  return chunks.join("\n").trim()
}

function isAssistant(message: unknown) {
  const record = asRecord(message)
  return record?.type === "assistant" || record?.role === "assistant"
}

/** The last assistant message's text. */
export function lastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!isAssistant(messages[index])) continue
    const text = readText(asRecord(messages[index]))
    if (text) return text
  }
  return ""
}

/** The last assistant text that carries a report header; empty when none does. */
export function lastReportText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!isAssistant(messages[index])) continue
    const text = readText(asRecord(messages[index]))
    if (!text) continue
    if (extractStatusLines(text).length > 0) return text
  }
  return ""
}

function cleanLine(line: string) {
  return line
    .trim()
    .replace(/^[#>*\-\s]+/, "")
    .replace(/\*\*/g, "")
    .trim()
}

const STATUS_PREFIXES = ["状态：", "需人决定：", "报告时间："] as const

/** The structured report header lines, in their fixed order; empty when absent. */
export function extractStatusLines(report: string): string[] {
  const lines = report.split(/\r?\n/).map(cleanLine)
  if (!lines.some((line) => line.startsWith("状态："))) return []
  return STATUS_PREFIXES.flatMap((prefix) => {
    const found = lines.find((line) => line.startsWith(prefix))
    return found ? [found] : []
  })
}

function formatStatus(report: string) {
  const lines = extractStatusLines(report)
  if (lines.length === 0) return HANDOFF_NO_REPORT
  const [status, ...rest] = lines
  return [status!.slice("状态：".length).trim(), ...rest].filter(Boolean).join("；")
}

const SECTION_HEADINGS = [
  "改动",
  "测试",
  "风险",
  "执行",
  "阶段小结",
  "阅读",
  "失败详情",
  "命令完整输出",
  "关键代码摘录",
  "每文件修改理由",
  "每步动机",
  "假设清单",
  "考虑过又放弃的方案",
  "剩余",
  "已完成",
] as const

const SECTION_RE = new RegExp(`^(?:${SECTION_HEADINGS.join("|")})[:：]`)

const SECTION_TEMPLATES: Record<string, readonly string[]> = {
  改动: ["文件清单，每个一句话"],
  测试: ["命令 + 结论", "命令 + 结果明细"],
  风险: ["遗留风险与未解决项"],
}

function isTemplateText(heading: string, value: string) {
  return (SECTION_TEMPLATES[heading] ?? []).includes(value)
}

/** The body under a report section heading, up to the next heading. */
function sectionBody(report: string, heading: string) {
  const lines = report.split(/\r?\n/).map(cleanLine)
  const start = lines.findIndex((line) => line.startsWith(`${heading}：`))
  if (start < 0) return ""
  const first = lines[start]!.slice(heading.length + 1).trim()
  const body: string[] = []
  if (first && !isTemplateText(heading, first)) body.push(first)
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!
    if (!line) continue
    if (SECTION_RE.test(line)) break
    body.push(line)
  }
  return body.join("；").trim()
}

const KNOWN_EXT =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|kt|rb|sh|yml|yaml|toml|txt|log|html|css|scss|sql|lock|ini|cfg|conf)$/i

const FILE_REF_RE = /((?:\.{0,2}\/)?(?:[\w.@~-]+\/)*[\w.@~-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+)(?:-\d+)?)?/g

/** File references (`path` or `path:line`) mentioned in the report, deduplicated. */
export function extractFileRefs(text: string): string[] {
  const refs: string[] = []
  for (const match of text.matchAll(FILE_REF_RE)) {
    const path = match[1]!
    if (!path.includes("/") && !KNOWN_EXT.test(path)) continue
    const ref = match[2] ? `${path}:${match[2]}` : path
    if (!refs.includes(ref)) refs.push(ref)
  }
  return refs
}

/** The changed-file list, or `见会话记录` when the report has nothing usable. */
export function extractCompleted(report: string): string {
  const body = sectionBody(report, "改动")
  if (body) return body
  const refs = extractFileRefs(report)
  return refs.length > 0 ? refs.join("、") : HANDOFF_SEE_RECORD
}

/** What is left or blocking; risk section first, then the blocked question. */
export function extractRemaining(report: string): string {
  const risk = sectionBody(report, "风险")
  if (risk) return risk
  const rest = sectionBody(report, "剩余")
  if (rest) return rest
  const status = extractStatusLines(report).find((line) => line.startsWith("状态：")) ?? ""
  if (/\bblocked\b/.test(status)) {
    const question = extractStatusLines(report)
      .find((line) => line.startsWith("需人决定："))
      ?.slice("需人决定：".length)
      .trim()
    if (question && question !== "无") return `待人决定：${question}`
  }
  return HANDOFF_NO_REPORT
}

/** The lookup pointers: touched files plus the original session record. */
export function extractPointers(report: string, sessionID: string, limit = 8): string {
  const refs = extractFileRefs(report).slice(0, Math.max(1, limit))
  const session = `原会话 ${sessionID}（Superagent 可翻查完整记录）`
  return refs.length > 0 ? `${refs.join("、")}；${session}` : session
}

function clip(text: string, max: number) {
  if (max <= 0) return ""
  if (text.length <= max) return text
  if (max === 1) return "…"
  return `${text.slice(0, max - 1)}…`
}

/**
 * Render a handoff summary. When the result exceeds `limit`, the completed
 * section is compressed first, then the remaining section is shortened; the
 * header, status and pointers keep their place.
 */
export function truncateHandoff(fields: HandoffFields, limit = HANDOFF_LIMIT): string {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : HANDOFF_LIMIT
  const header = `# 交接：${clip(fields.title.trim() || "未命名会话", 80)}`
  const status = `状态：${clip(fields.status.trim() || HANDOFF_NO_REPORT, 300)}`
  const remainingText = fields.remaining.trim() || HANDOFF_NO_REPORT
  const pointersText = fields.pointers.trim()
  const pointers = `关键指针：${pointersText || "无"}`
  let completed = `已完成：${fields.completed.trim() || HANDOFF_SEE_RECORD}`
  let remaining = `剩余：${remainingText}`

  const assemble = () => [header, status, completed, remaining, pointers].join("\n")
  if (assemble().length <= cap) return assemble()

  completed = `已完成：${HANDOFF_COMPRESSED_COMPLETED}`
  if (assemble().length <= cap) return assemble()

  remaining = `剩余：${clip(remainingText, 300)}`
  if (assemble().length <= cap) return assemble()

  const base = [header, status, completed, remaining, "关键指针："].join("\n").length
  const pointerRoom = cap - base - 1
  if (pointerRoom > 8) {
    const shortened = [header, status, completed, remaining, `关键指针：${clip(pointersText, pointerRoom)}`].join("\n")
    if (shortened.length <= cap) return shortened
  }

  return clip(assemble(), cap)
}

function titleOf(info: HandoffSessionInfo | undefined) {
  const title = typeof info?.title === "string" ? info.title.trim() : ""
  return title || "未命名会话"
}

async function listMessages(client: HandoffClient, sessionID: string): Promise<unknown[]> {
  const lister = client.message?.list ?? client.session?.message?.list
  if (!lister) return []
  const raw = await lister({ sessionID })
  if (Array.isArray(raw)) return raw as unknown[]
  const data = (raw as { data?: readonly unknown[] } | undefined)?.data
  return Array.isArray(data) ? (data as unknown[]) : []
}

function minimalHandoff(title: string, sessionID: string) {
  return truncateHandoff({
    title,
    status: HANDOFF_NO_REPORT,
    completed: HANDOFF_SEE_RECORD,
    remaining: HANDOFF_SEE_RECORD,
    pointers: `原会话 ${sessionID}（Superagent 可翻查完整记录）`,
  })
}

/**
 * Build a one-page handoff summary from the old Subagent session.
 * Never throws: a missing title, a failed message list or an unparsable report
 * all degrade to a minimal summary that still points at the full record.
 */
export async function buildHandoffSummary(input: BuildHandoffInput): Promise<string> {
  const sessionID = input.childSessionID
  let title = "未命名会话"
  try {
    title = titleOf(await input.client.session?.get?.({ sessionID }))
  } catch {
    title = "未命名会话"
  }

  try {
    const messages = await listMessages(input.client, sessionID)
    const report = lastReportText(messages)
    if (!report) return minimalHandoff(title, sessionID)
    return truncateHandoff({
      title,
      status: formatStatus(report),
      completed: extractCompleted(report),
      remaining: extractRemaining(report),
      pointers: extractPointers(report, sessionID),
    })
  } catch {
    return minimalHandoff(title, sessionID)
  }
}