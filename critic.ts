/**
 * The critic: an independent read-only check of a Subagent's report.
 *
 * A Subagent's report is a claim. The critic re-reads that Subagent's own
 * session record and the files the Subagent touched, then answers with one
 * of four verdicts. It runs in a separate `explore` session, so it cannot
 * change anything it reviews, and that session is deleted right after, so it
 * never occupies a Subagent slot.
 *
 * Every call to the outside world is fail-safe: a failed create, a timeout or
 * a failed delete degrades to `证据不足` instead of throwing.
 */

export const CRITIC_VERDICTS = ["一致", "部分不一致", "严重不一致", "证据不足"] as const
export type CriticVerdict = (typeof CRITIC_VERDICTS)[number]

/** The read-only agent the critic runs as. */
export const CRITIC_AGENT = "explore"

/** Title prefix of a critic session; also used to recognise one. */
export const CRITIC_TITLE_PREFIX = "Critic: 复核 "

/** Metadata key that marks a session as a critic session. */
export const CRITIC_MARKER_KEY = "superagent.critic"

/** Metadata key that records which session a critic session reviews. */
export const CRITIC_TARGET_KEY = "superagent.criticOf"

export const CRITIC_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
export const CRITIC_DEFAULT_POLL_MS = 1000

/** The JSON values the client accepts as session metadata. */
export type CriticJsonValue = string | number | boolean | null | CriticJsonValue[] | { [key: string]: CriticJsonValue }

/** The slice of the OpenCode client this module uses. */
export type CriticSessionInfo = {
  readonly id: string
  readonly title?: string
  readonly parentID?: string
  readonly outcome?: string
  readonly time?: { readonly busy?: number; readonly idle?: number }
  readonly metadata?: Record<string, CriticJsonValue>
}

/** The message list, in either the bare-array or the `{ data }` shape. */
export type CriticMessageList = readonly unknown[] | { readonly data?: readonly unknown[] }

/** The slice of the OpenCode client this module uses. */
export type CriticClient = {
  readonly session: {
    create(input: {
      readonly parentID?: string
      readonly agent?: string
      readonly title?: string
      readonly metadata?: Record<string, CriticJsonValue>
    }): Promise<CriticSessionInfo>
    get(input: { readonly sessionID: string }): Promise<CriticSessionInfo>
    update(input: {
      readonly sessionID: string
      readonly title?: string
      readonly metadata?: Record<string, CriticJsonValue>
    }): Promise<unknown>
    prompt(input: { readonly sessionID: string; readonly text: string }): Promise<unknown>
    remove(input: { readonly sessionID: string }): Promise<unknown>
    /** The generated client puts message listing at `client.message.list`. */
    readonly message?: {
      readonly list?: (input: { readonly sessionID: string; readonly limit?: number }) => Promise<CriticMessageList>
      readonly [key: string]: unknown
    }
  }
  readonly message?: {
    readonly list?: (input: { readonly sessionID: string; readonly limit?: number }) => Promise<CriticMessageList>
    readonly [key: string]: unknown
  }
}

export type CriticReviewInput = {
  readonly client: CriticClient
  /** The Subagent session whose report is being checked. */
  readonly childSessionID: string
  /** The family root the critic session is created under. */
  readonly rootID: string
  /** The report text the Subagent produced. */
  readonly reportText: string
}

export type CriticReviewOptions = {
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
  readonly agent?: string
  /** Directory that holds the daily audit files. */
  readonly auditDir?: string
  /** Receives the failure trail; the audit row always carries it too. */
  readonly log?: (entry: Record<string, unknown>) => void
  /** 插件卸载时中止轮询，并阻止后续复核副作用。 */
  readonly signal?: AbortSignal
}

export type CriticReviewResult = {
  readonly verdict: CriticVerdict
  readonly differences: string[]
  /** The audit file this review was written to. */
  readonly auditPath: string
  /** True when the review was skipped because the Subagent is a critic itself. */
  readonly skipped: boolean
}

export type CriticAuditRow = {
  readonly v: 1
  readonly ts: string
  readonly childSessionID: string
  readonly criticSessionID?: string
  readonly verdict: CriticVerdict
  readonly differences: string[]
  readonly differenceCount: number
  readonly durationMs: number
  readonly skipped: boolean
  readonly note?: string
}

/** True when a session is a critic session and must not be reviewed again. */
export function isCriticSession(
  session: { readonly title?: string; readonly metadata?: Record<string, unknown> } | undefined,
): boolean {
  if (!session) return false
  if (session.metadata?.[CRITIC_MARKER_KEY] === true) return true
  const title = session.title ?? ""
  return title.startsWith(CRITIC_TITLE_PREFIX) || title.startsWith("[critic]")
}

/**
 * Reads the verdict and the differences out of the critic's own answer.
 *
 * A labelled `verdict:` line wins; otherwise the first verdict token in the
 * text decides. `一致` is only read when it is not the tail of `不一致`.
 */
export function parseCriticVerdict(text: string): { verdict: CriticVerdict; differences: string[] } {
  const lines = text.split(/\r?\n/)
  let verdict: CriticVerdict | undefined
  for (const line of lines) {
    const labelled = /^\s*(?:verdict|结论|判定|总体结论)\s*[:：]\s*(.+)$/i.exec(line)
    if (!labelled) continue
    const found = matchVerdict(labelled[1])
    if (found) {
      verdict = found
      break
    }
  }
  if (!verdict) {
    for (const line of lines) {
      const found = matchVerdict(line)
      if (found) {
        verdict = found
        break
      }
    }
  }
  return { verdict: verdict ?? "证据不足", differences: parseDifferences(lines) }
}

function matchVerdict(text: string): CriticVerdict | undefined {
  const match = /(严重不一致|部分不一致|证据不足|(?<!不)一致)/.exec(text)
  if (!match) return undefined
  return match[1] as CriticVerdict
}

function parseDifferences(lines: readonly string[]): string[] {
  const marker = lines.findIndex((line) => /^\s*(?:differences|差异|差异项|不一致项)\s*[:：]?\s*$/i.test(line))
  const scope = marker >= 0 ? lines.slice(marker + 1) : lines
  const differences: string[] = []
  for (const line of scope) {
    const bullet = /^\s*(?:[-*•]\s+|\d+[.)]\s+)(.+)$/.exec(line)
    if (!bullet) continue
    const text = bullet[1].trim()
    if (!text || /^(?:无|none|n\/a)$/i.test(text)) continue
    differences.push(text)
  }
  return differences
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  return value as Record<string, unknown>
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

function partsOf(message: unknown): readonly unknown[] {
  const record = asRecord(message)
  if (!record) return []
  const content = record.content
  if (Array.isArray(content)) return content
  const parts = record.parts
  if (Array.isArray(parts)) return parts
  return []
}

/** The text of one message, excluding reasoning and tool output. */
export function messageText(message: unknown): string {
  const record = asRecord(message)
  if (!record) return ""
  const chunks: string[] = []
  const direct = readString(record, "text")
  if (direct) chunks.push(direct)
  for (const part of partsOf(message)) {
    const partRecord = asRecord(part)
    if (partRecord?.type !== "text") continue
    const text = readString(partRecord, "text")
    if (text) chunks.push(text)
  }
  return chunks.join("\n").trim()
}

/** The last assistant message's text, which is the critic's answer. */
export function lastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const record = asRecord(messages[index])
    if (!record) continue
    if (record.type !== "assistant" && record.role !== "assistant") continue
    const text = messageText(messages[index])
    if (text) return text
  }
  return ""
}

const INPUT_KEYS = ["filePath", "path", "file", "command", "pattern", "query", "description", "url"] as const
const RECORD_MAX_LINES = 200
const RECORD_MAX_CHARS = 60_000
const EVIDENCE_MAX_CHARS = 600
const TRUNCATION_MARKER = "…[截断]"

/** One line per tool call or shell command, so the critic sees what ran. */
export function summarizeSessionRecord(messages: readonly unknown[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const record = asRecord(message)
    if (!record) continue
    const command = readString(record, "command")
    if (command) {
      lines.push(`[shell] ${command} ${describeExecution(evidenceContainers(record)).join(" ")}`.trimEnd())
      continue
    }
    for (const part of partsOf(message)) {
      const partRecord = asRecord(part)
      if (!partRecord || partRecord.type !== "tool") continue
      const name = readString(partRecord, "name") ?? readString(partRecord, "tool") ?? "tool"
      const state = asRecord(partRecord.state)
      const input = asRecord(state?.input) ?? asRecord(partRecord.input)
      const details = [describeInput(input), ...describeExecution(evidenceContainers(partRecord, state))].filter(Boolean)
      lines.push(`[tool:${name}]${details.length > 0 ? ` ${details.join(" ")}` : ""}`)
    }
  }
  const selected = lines.slice(0, RECORD_MAX_LINES)
  if (lines.length > RECORD_MAX_LINES && selected.length > 0) {
    selected[selected.length - 1] += " …[后续工具记录已截断]"
  }
  return clipText(selected.join("\n"), RECORD_MAX_CHARS)
}

function evidenceContainers(
  part: Record<string, unknown>,
  state?: Record<string, unknown>,
): Record<string, unknown>[] {
  return [state, part, asRecord(state?.metadata), asRecord(part.metadata)].filter(
    (value): value is Record<string, unknown> => value !== undefined,
  )
}

function describeExecution(containers: readonly Record<string, unknown>[]): string[] {
  const details: string[] = []
  const status = firstString(containers, "status")
  if (status) details.push(`status=${oneLine(status)}`)
  const exit = firstExitCode(containers)
  if (exit !== undefined) details.push(`exit=${exit}`)
  const error = firstError(containers)
  if (error) details.push(`error=${summarizeEvidence(error)}`)
  const output = firstOutput(containers)
  if (output) details.push(`output=${summarizeEvidence(output)}`)
  return details
}

function firstString(containers: readonly Record<string, unknown>[], key: string): string | undefined {
  for (const container of containers) {
    const value = readString(container, key)
    if (value) return value
  }
  return undefined
}

function firstExitCode(containers: readonly Record<string, unknown>[]): number | undefined {
  for (const container of containers) {
    for (const key of ["exitCode", "exit_code", "exit"]) {
      const value = container[key]
      if (typeof value === "number" && Number.isFinite(value)) return value
    }
  }
  return undefined
}

function firstError(containers: readonly Record<string, unknown>[]): string | undefined {
  for (const container of containers) {
    const value = container.error
    if (typeof value === "string" && value.trim()) return value
    const message = readString(asRecord(value), "message")
    if (message?.trim()) return message
  }
  return undefined
}

function firstOutput(containers: readonly Record<string, unknown>[]): string | undefined {
  for (const container of containers) {
    const output = readString(container, "output")
    if (output?.trim()) return output
    const content = container.content
    if (typeof content === "string" && content.trim()) return content
    if (!Array.isArray(content)) continue
    const chunks: string[] = []
    for (const item of content) {
      const itemRecord = asRecord(item)
      if (itemRecord?.type !== "text") continue
      const text = readString(itemRecord, "text")
      if (text) chunks.push(text)
    }
    if (chunks.length > 0) return chunks.join("\n")
  }
  return undefined
}

function summarizeEvidence(text: string): string {
  return clipText(oneLine(text.trim()), EVIDENCE_MAX_CHARS)
}

function oneLine(text: string): string {
  return text.replace(/\r/g, "\\r").replace(/\n/g, "\\n")
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
}

/** The files the session touched, from the tool inputs. */
export function collectRecordFiles(messages: readonly unknown[]): string[] {
  const files = new Set<string>()
  for (const message of messages) {
    for (const part of partsOf(message)) {
      const partRecord = asRecord(part)
      if (!partRecord || partRecord.type !== "tool") continue
      const state = asRecord(partRecord.state)
      const input = asRecord(state?.input) ?? asRecord(partRecord.input)
      if (!input) continue
      for (const key of INPUT_KEYS) {
        const value = input[key]
        if (typeof value === "string" && value.length > 0) files.add(value)
      }
    }
  }
  return Array.from(files)
}

function describeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  const parts: string[] = []
  for (const key of INPUT_KEYS) {
    const value = input[key]
    if (typeof value !== "string" || value.length === 0) continue
    parts.push(`${key}=${clipText(oneLine(value), 120)}`)
  }
  return parts.join(" ")
}

/** The task the critic session receives. */
export function buildCriticPrompt(input: {
  readonly reportText: string
  readonly record: string
  readonly files: readonly string[]
}): string {
  return [
    "你是独立复核代理（critic）。你只读不改：不修改任何文件，不执行写操作。",
    "你唯一的任务是核对下面这份「子代理报告」是否与真实记录一致。",
    "",
    "## 1. 待复核的子代理报告",
    input.reportText.trim() || "（子代理没有产出报告正文）",
    "",
    "## 2. 该子会话的真实记录摘要（工具调用与命令）",
    input.record.trim() || "（未从宿主消息提取到工具记录，不代表命令未执行）",
    "",
    "## 3. 涉及的文件",
    input.files.length > 0 ? input.files.join("\n") : "（记录里没有出现文件路径）",
    "",
    "## 4. 核查要求",
    "逐项核对，只依据上面给出的记录与文件实际内容判断，不得臆测：",
    "- 报告声称改动的文件：文件是否真实存在所述修改。",
    "- 报告声称执行的测试：命令是否真的执行过，输出与结论是否一致。",
    "- 报告声称读过的文件：是否确有读取记录。",
    "- 报告是否遗漏了实际存在但未报告的风险、失败或未完成项。",
    "- 工具记录缺失或为空时，相关事项只能判为证据不足；不得据此断言命令未执行、文件未读取或报告虚假。",
    "- 有真实记录与报告直接矛盾时，仍须按差异程度判为部分不一致或严重不一致，不得因记录不完整而忽略已确认的矛盾。",
    "",
    "## 5. 输出格式（严格遵守）",
    "先输出一行 `verdict: <结论>`，结论只能是下面四个之一，不得改写：",
    ...CRITIC_VERDICTS,
    "",
    "再输出一行 `differences:`，随后每条差异独占一行并以 `- ` 开头；没有差异时写 `- 无`。",
  ].join("\n")
}

/**
 * Checks a Subagent's report against its own session record.
 *
 * The critic session is created, prompted, awaited, read and deleted. The
 * verdict is `证据不足` whenever the check could not be carried out.
 */
export async function criticReview(
  input: CriticReviewInput,
  options: CriticReviewOptions = {},
): Promise<CriticReviewResult> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? CRITIC_DEFAULT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? CRITIC_DEFAULT_POLL_MS
  const log = options.log
  const auditDir = options.auditDir ?? (await defaultAuditDir())
  const auditPath = await auditPathFor(auditDir, new Date())

  let criticSessionID: string | undefined
  let verdict: CriticVerdict = "证据不足"
  let differences: string[] = []
  let skipped = false
  let note: string | undefined

  try {
    throwIfAborted(options.signal)
    const child = await getSession(input.client, input.childSessionID)
    throwIfAborted(options.signal)
    if (isCriticSession(child)) {
      skipped = true
      note = "跳过：子会话本身是复核会话，避免递归复核"
    } else {
      const childMessages = await listMessages(input.client, input.childSessionID)
      throwIfAborted(options.signal)
      const record = summarizeSessionRecord(childMessages)
      const files = collectRecordFiles(childMessages)
      const title = `${CRITIC_TITLE_PREFIX}${child?.title?.trim() || input.childSessionID}`

      throwIfAborted(options.signal)
      const created = await input.client.session.create({
        parentID: input.rootID,
        agent: options.agent ?? CRITIC_AGENT,
        title,
      })
      criticSessionID = created.id
      throwIfAborted(options.signal)

      // The marker is written after creation, so the critic session keeps the
      // metadata it inherited from its parent and the title already identifies
      // it even when this patch fails.
      await input.client.session.update({
        sessionID: created.id,
        metadata: {
          ...(created.metadata ?? {}),
          [CRITIC_MARKER_KEY]: true,
          [CRITIC_TARGET_KEY]: input.childSessionID,
        },
      })
      throwIfAborted(options.signal)

      await input.client.session.prompt({
        sessionID: created.id,
        text: buildCriticPrompt({ reportText: input.reportText, record, files }),
      })

      throwIfAborted(options.signal)
      const finished = await waitForCompletion(input.client, created.id, timeoutMs, pollIntervalMs, options.signal)
      if (!finished.ok) {
        note = finished.reason
        differences = [finished.reason]
      } else {
        const criticMessages = await listMessages(input.client, created.id)
        const answer = lastAssistantText(criticMessages)
        const parsed = parseCriticVerdict(answer)
        verdict = parsed.verdict
        differences = parsed.differences
        if (!answer) note = "复核会话没有产出结论"
      }
    }
  } catch (cause) {
    note = `复核失败：${errorText(cause)}`
    differences = [note]
    verdict = "证据不足"
    log?.({ event: "critic-failed", childSessionID: input.childSessionID, error: note })
  } finally {
    if (criticSessionID) {
      try {
        await input.client.session.remove({ sessionID: criticSessionID })
      } catch (cause) {
        log?.({ event: "critic-remove-failed", sessionID: criticSessionID, error: errorText(cause) })
      }
    }
  }

  await writeAuditRow(auditPath, {
    v: 1,
    ts: new Date().toISOString(),
    childSessionID: input.childSessionID,
    criticSessionID,
    verdict,
    differences: differences.slice(0, 20),
    differenceCount: differences.length,
    durationMs: Date.now() - started,
    skipped,
    note,
  })

  return { verdict, differences, auditPath, skipped }
}

async function getSession(client: CriticClient, sessionID: string) {
  try {
    return await client.session.get({ sessionID })
  } catch {
    return undefined
  }
}

async function listMessages(client: CriticClient, sessionID: string): Promise<unknown[]> {
  const lister = client.session.message?.list ?? client.message?.list
  if (!lister) return []
  try {
    return normalizeMessages(await lister({ sessionID }))
  } catch {
    return []
  }
}

function normalizeMessages(raw: CriticMessageList | undefined): unknown[] {
  if (Array.isArray(raw)) return raw as unknown[]
  const data = (raw as { data?: readonly unknown[] } | undefined)?.data
  return Array.isArray(data) ? (data as unknown[]) : []
}

type WaitResult = { ok: true } | { ok: false; reason: string }

/**
 * Waits until the critic session stops running.
 *
 * A session is finished once its last execution ended: `time.idle` is set
 * and is not older than `time.busy`.
 */
async function waitForCompletion(
  client: CriticClient,
  sessionID: string,
  timeoutMs: number,
  pollIntervalMs: number,
  signal?: AbortSignal,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs
  let failures = 0
  for (;;) {
    throwIfAborted(signal)
    const info = await getSession(client, sessionID)
    throwIfAborted(signal)
    if (!info) {
      failures++
      if (failures >= 3) return { ok: false, reason: "复核会话无法读取，判定为证据不足" }
    } else {
      failures = 0
      if (isFinished(info)) return { ok: true }
    }
    if (Date.now() >= deadline) return { ok: false, reason: `复核超时（${timeoutMs}ms），判定为证据不足` }
    await sleep(pollIntervalMs, signal)
  }
}

function isFinished(session: CriticSessionInfo): boolean {
  const busy = session.time?.busy
  const idle = session.time?.idle
  if (idle === undefined) return false
  if (busy === undefined) return true
  return idle >= busy
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error("复核已取消")
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("复核已取消"))
      return
    }
    const done = () => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(signal?.reason instanceof Error ? signal.reason : new Error("复核已取消"))
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

async function defaultAuditDir(): Promise<string> {
  const os = await import("node:os")
  const path = await import("node:path")
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(state, "opencode", "superagent", "critic")
}

async function auditPathFor(auditDir: string, at: Date): Promise<string> {
  const path = await import("node:path")
  return path.join(auditDir, `${at.toISOString().slice(0, 10)}.jsonl`)
}

async function writeAuditRow(auditPath: string, row: CriticAuditRow): Promise<void> {
  try {
    const path = await import("node:path")
    const fs = await import("node:fs/promises")
    await fs.mkdir(path.dirname(auditPath), { recursive: true })
    await fs.appendFile(auditPath, `${JSON.stringify(row)}\n`)
  } catch {
    // An unwritable audit file must not break the review.
  }
}
