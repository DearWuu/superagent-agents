/**
 * Superagent ↔ Subagent 的状态回传：派发台账、回执文案、后台任务识别、通知与提醒文案，
 * 以及子代理看护与周期对账。
 *
 * 本模块不直接依赖宿主 ctx：宿主能力（读会话、读消息、读条目、投递通知、写标记）
 * 全部由调用方注入，所以判定都能被单测直接驱动。宿主接线在 server.ts。
 */

/** 派发模式：新建子会话，还是续跑已有子会话。 */
export type DispatchMode = "new" | "steer"

/** 续跑前置中断的结果：无需中断、已中断、显式关闭、中断失败。 */
export type InterruptState = "not-needed" | "interrupted" | "off" | "failed"

/** 派发判定：放行还是被拒绝。 */
export type DispatchDecision = "allowed" | "denied"

/** 一次派发的登记信息：回执、告警与状态回传都以它为准。 */
export type DispatchRecord = {
  callID: string
  parentID: string
  /** 派发所在 root；开关与上限都按 root 生效。 */
  rootID?: string
  /** 子会话 ID：派发成功后才有。 */
  childID?: string
  description: string
  agent: string
  model?: string
  mode: DispatchMode
  decision: DispatchDecision
  background: boolean
  interrupt: InterruptState
  evicted: string[]
  warnings: string[]
  /** 拒绝原因（decision=denied 时有值）。 */
  reason?: string
  /** 子会话当前状态：running / completed / error / cancelled。 */
  state?: string
  elapsedMs?: number
  startedAt: number
  updatedAt: number
}

export type DispatchInit = {
  parentID: string
  rootID?: string
  description?: string
  agent?: string
  model?: string
  mode?: DispatchMode
  decision?: DispatchDecision
  background?: boolean
  interrupt?: InterruptState
  evicted?: string[]
  warnings?: string[]
  startedAt?: number
}

export type DispatchPatch = Partial<Omit<DispatchRecord, "callID" | "startedAt">>

export type DispatchLedger = {
  /** 登记一次派发；同一 callID 合并，不重置已记录的字段。 */
  begin: (callID: string, init: DispatchInit) => DispatchRecord
  /** 改写登记信息；没有该 callID 时什么都不做（协作关闭的调用不进台账）。 */
  update: (callID: string, patch: DispatchPatch) => DispatchRecord | undefined
  /** 追加一条告警（fail-open 等）。 */
  warn: (callID: string, text: string) => DispatchRecord | undefined
  peek: (callID: string) => DispatchRecord | undefined
  /** 取出并移除。 */
  take: (callID: string) => DispatchRecord | undefined
  /** 清掉过期登记，并维持上限。 */
  prune: (now?: number, maxAgeMs?: number) => void
  size: () => number
}

/** 台账默认上限：超出后淘汰最旧的一条。 */
export const DISPATCH_LEDGER_LIMIT = 200
/** 台账默认保留时长。 */
export const DISPATCH_LEDGER_TTL_MS = 6 * 60 * 60 * 1000
/** 回执最大长度（字符）。 */
export const MAX_RECEIPT_LENGTH = 500
/** 完成通知正文最大长度（字符）。 */
export const MAX_NOTICE_TEXT_LENGTH = 4000

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (isRecord(value) && Array.isArray(value.data)) return value.data
  return []
}

function copyRecord(record: DispatchRecord): DispatchRecord {
  return { ...record, evicted: [...record.evicted], warnings: [...record.warnings] }
}

/**
 * 派发台账：按 callID 合并登记，回执与状态回传都从这里取。
 * 不含模块级可变状态：每个实例一份，测试可多实例并存。
 */
export function createDispatchLedger(limit = DISPATCH_LEDGER_LIMIT): DispatchLedger {
  const records = new Map<string, DispatchRecord>()
  const cap = Math.max(1, Math.floor(limit))
  const evictOldest = () => {
    while (records.size > cap) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, record] of records) {
        if (record.startedAt < oldestAt) {
          oldestAt = record.startedAt
          oldestKey = key
        }
      }
      if (oldestKey === undefined) return
      records.delete(oldestKey)
    }
  }
  const begin = (callID: string, init: DispatchInit): DispatchRecord => {
    const now = Date.now()
    const existing = records.get(callID)
    const base: DispatchRecord = existing ?? {
      callID,
      parentID: init.parentID,
      description: "",
      agent: "",
      mode: "new",
      decision: "allowed",
      background: false,
      interrupt: "not-needed",
      evicted: [],
      warnings: [],
      startedAt: init.startedAt ?? now,
      updatedAt: now,
    }
    const record: DispatchRecord = {
      ...base,
      callID,
      parentID: init.parentID ?? base.parentID,
      rootID: init.rootID ?? base.rootID,
      description: init.description ?? base.description,
      agent: init.agent ?? base.agent,
      model: init.model ?? base.model,
      mode: init.mode ?? base.mode,
      decision: init.decision ?? base.decision,
      background: init.background ?? base.background,
      interrupt: init.interrupt ?? base.interrupt,
      evicted: init.evicted ? [...init.evicted] : [...base.evicted],
      warnings: init.warnings ? [...init.warnings] : [...base.warnings],
      startedAt: base.startedAt,
      updatedAt: now,
    }
    records.set(callID, record)
    evictOldest()
    return copyRecord(record)
  }
  const update = (callID: string, patch: DispatchPatch): DispatchRecord | undefined => {
    const existing = records.get(callID)
    if (!existing) return undefined
    const next: DispatchRecord = {
      ...existing,
      ...patch,
      evicted: patch.evicted ? [...patch.evicted] : existing.evicted,
      warnings: patch.warnings ? [...patch.warnings] : existing.warnings,
      updatedAt: Date.now(),
    }
    records.set(callID, next)
    return copyRecord(next)
  }
  const warn = (callID: string, text: string): DispatchRecord | undefined => {
    const existing = records.get(callID)
    if (!existing) return undefined
    return update(callID, { warnings: [...existing.warnings, text] })
  }
  const peek = (callID: string): DispatchRecord | undefined => {
    const found = records.get(callID)
    return found ? copyRecord(found) : undefined
  }
  const take = (callID: string): DispatchRecord | undefined => {
    const found = peek(callID)
    if (found) records.delete(callID)
    return found
  }
  const prune = (now = Date.now(), maxAgeMs = DISPATCH_LEDGER_TTL_MS) => {
    for (const [key, record] of records) {
      if (now - record.updatedAt > maxAgeMs) records.delete(key)
    }
    evictOldest()
  }
  return { begin, update, warn, peek, take, prune, size: () => records.size }
}

/** 派发结果：决定回执里的 dispatch 与 state。 */
export type DispatchOutcome = {
  ok?: boolean
  state?: string
  warning?: string
}

/**
 * 派发回执：一行键值，模型一眼能看懂这次派发发生了什么。
 * 失败或告警追加 `warning=`；总长不超过 500 字。
 */
export function formatDispatchReceipt(record: DispatchRecord, outcome: DispatchOutcome = {}): string {
  const ok = outcome.ok !== false && record.decision !== "denied"
  const parts: string[] = [`[superagent] dispatch=${ok ? "ok" : "failed"}`, `mode=${record.mode}`]
  if (record.childID) parts.push(`child=${record.childID}`)
  parts.push(`state=${outcome.state ?? record.state ?? (record.background ? "running" : "completed")}`)
  if (record.model) parts.push(`model=${record.model}`)
  parts.push(`interrupt=${record.interrupt}`)
  if (record.evicted.length > 0) parts.push(`evicted=${record.evicted.join(",")}`)
  // 只有仍在运行/等待后台收尾的派发才需要承诺后续通知；前台已完成的调用
  // 工具结果本身就是最终输出，再写“完成后自动通知”会误导模型。
  if (ok && (outcome.state ?? record.state) === "running") parts.push("完成后自动通知")
  const warnings = [...record.warnings, ...(outcome.warning ? [outcome.warning] : [])]
  for (const warning of warnings) parts.push(`warning=${warning}`)
  const text = parts.join(" · ")
  return text.length > MAX_RECEIPT_LENGTH ? `${text.slice(0, MAX_RECEIPT_LENGTH - 1)}…` : text
}

/**
 * 把回执挂到工具结果上：优先 content，其次 output，最后 metadata.superagent。
 * 不改变 result 的类型；任何异常都吞掉并原样返回。
 */
export function attachDispatchReceipt(result: any, text: string): any {
  try {
    if (!isRecord(result)) return result
    if (typeof result.content === "string") {
      result.content = result.content ? `${result.content}\n${text}` : text
      return result
    }
    if (Array.isArray(result.content)) {
      result.content = [...result.content, { type: "text", text }]
      return result
    }
    if (typeof result.output === "string") {
      result.output = result.output ? `${result.output}\n${text}` : text
      return result
    }
    const metadata = isRecord(result.metadata) ? result.metadata : {}
    result.metadata = { ...metadata, superagent: text }
    return result
  } catch {
    return result
  }
}

/** 一个还在跑的后台任务。 */
export type BackgroundJob = {
  kind: "shell" | "subagent"
  id: string
  command: string
}

/** 后台 shell 消息：后台启动且仍在运行。 */
export function isRunningBackgroundShell(message: unknown): BackgroundJob | undefined {
  const record = isRecord(message) ? message : undefined
  if (!record || record.type !== "shell") return undefined
  const metadata = isRecord(record.metadata) ? record.metadata : undefined
  if (!metadata || metadata.background !== true) return undefined
  if (record.status !== "running") return undefined
  const id = typeof record.shellID === "string" && record.shellID ? record.shellID : typeof record.id === "string" ? record.id : ""
  return { kind: "shell", id, command: typeof record.command === "string" ? record.command : "" }
}

function partsOf(message: Record<string, any>): any[] {
  if (Array.isArray(message.content)) return message.content
  if (Array.isArray(message.parts)) return message.parts
  return []
}

/** 子代理工具结果里仍在跑的子会话。 */
function runningSubagentJob(part: unknown): BackgroundJob | undefined {
  if (!isRecord(part) || part.type !== "tool") return undefined
  const state = isRecord(part.state) ? part.state : undefined
  if (!state) return undefined
  const metadata = isRecord(state.metadata) ? state.metadata : undefined
  if (!metadata || metadata.status !== "running") return undefined
  const sessionID = typeof metadata.sessionID === "string" ? metadata.sessionID : undefined
  if (!sessionID) return undefined
  const input = isRecord(state.input) ? state.input : {}
  const description = typeof input.description === "string" ? input.description : ""
  const agent = typeof input.agent === "string" ? input.agent : ""
  return { kind: "subagent", id: sessionID, command: description || agent || "subagent" }
}

/** 会话消息里所有还在跑的后台任务。 */
export function collectBackgroundJobs(messages: unknown): BackgroundJob[] {
  const jobs: BackgroundJob[] = []
  for (const message of toArray(messages)) {
    const shell = isRunningBackgroundShell(message)
    if (shell) jobs.push(shell)
    if (!isRecord(message)) continue
    for (const part of partsOf(message)) {
      const job = runningSubagentJob(part)
      if (job) jobs.push(job)
    }
  }
  return jobs
}

/** 后台任务集合的签名：任务换了一批就要重新通知。 */
export function jobSignature(jobs: BackgroundJob[]): string {
  return jobs
    .map((job) => `${job.kind}:${job.id}`)
    .sort()
    .join("|")
}

/** 子会话结束态：完成、失败还是中断。 */
export type CompletionState = "completed" | "error" | "cancelled"

/** 会话 outcome 到结束态的映射；认不出就返回 undefined。 */
export function completionState(outcome: unknown): CompletionState | undefined {
  if (outcome === "succeeded") return "completed"
  if (outcome === "failed" || outcome === "error") return "error"
  if (outcome === "interrupted" || outcome === "cancelled") return "cancelled"
  return undefined
}

/** 判重时可接受的结束态写法（宿主与插件的措辞可能不同）。 */
export function noticeStates(state: CompletionState): string[] {
  if (state === "error") return ["error", "failed"]
  if (state === "cancelled") return ["cancelled", "interrupted"]
  return ["completed", "succeeded"]
}

/** 后台任务仍在跑时的通知正文。 */
export function formatBackgroundNotice(input: {
  childID: string
  description?: string
  jobs: BackgroundJob[]
}): string {
  const attributes = [`sessionID="${input.childID}"`, `state="idle-background"`]
  if (input.description) attributes.push(`description="${input.description}"`)
  const lines: string[] = [`<subagent ${attributes.join(" ")}>`]
  lines.push(`子代理回合已结束，但仍有 ${input.jobs.length} 个后台任务在运行：`)
  // 后台命令可能很长，通知只保留可识别的开头，避免把主会话上下文撑爆。
  for (const job of input.jobs) {
    const command = job.command.length > 200 ? `${job.command.slice(0, 199)}…` : job.command
    lines.push(`- ${job.kind}: ${command}`)
  }
  lines.push("结束后会再次通知。")
  lines.push("</subagent>")
  const text = lines.join("\n")
  return text.length > MAX_NOTICE_TEXT_LENGTH ? `${text.slice(0, MAX_NOTICE_TEXT_LENGTH - 1)}…` : text
}

/** 完成/失败/中断的通知正文：格式与原生 `<subagent ...>` 一致。 */
export function formatCompletionNotice(input: {
  childID: string
  description?: string
  state: CompletionState
  text?: string
}): string {
  const attributes = [`sessionID="${input.childID}"`, `state="${input.state}"`]
  if (input.description) attributes.push(`description="${input.description}"`)
  const body = (input.text ?? "").slice(0, MAX_NOTICE_TEXT_LENGTH)
  return `<subagent ${attributes.join(" ")}>\n${body}\n</subagent>`
}

/** 对账兜底的提醒正文。 */
export function formatWatchReminder(input: { childID: string; state: CompletionState }): string {
  return `[superagent] 监测到子代理 ${input.childID} 已停止（${input.state}），但此前未收到完成确认。请验收或续跑。`
}

function noticeMetadata(message: Record<string, any>): Record<string, any> | undefined {
  if (isRecord(message.metadata)) return message.metadata
  if (isRecord(message.payload) && isRecord(message.payload.metadata)) return message.payload.metadata
  return undefined
}

/** 消息正文：文本、parts 文本与工具结果文本都算。 */
export function messageText(message: unknown): string {
  const record = isRecord(message) ? message : undefined
  if (!record) return ""
  const chunks: string[] = []
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) chunks.push(value)
  }
  push(record.text)
  if (isRecord(record.payload)) push(record.payload.text)
  for (const part of partsOf(record)) {
    if (!isRecord(part)) continue
    if (part.type === "text" || part.type === undefined) push(part.text)
    if (part.type === "tool" && isRecord(part.state) && Array.isArray(part.state.content)) {
      for (const item of part.state.content) {
        if (isRecord(item) && item.type === "text") push(item.text)
      }
    }
  }
  return chunks.join("\n").trim()
}

/** 最后一条 assistant 消息的正文：只取文本片段，不混入推理与工具输出。 */
export function finalAssistantText(messages: unknown): string {
  const list = toArray(messages)
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const record = isRecord(list[index]) ? list[index] : undefined
    if (!record) continue
    if (record.type !== "assistant" && record.role !== "assistant") continue
    const chunks: string[] = []
    if (typeof record.text === "string" && record.text.trim()) chunks.push(record.text)
    for (const part of partsOf(record)) {
      if (!isRecord(part) || part.type !== "text") continue
      if (typeof part.text === "string" && part.text.trim()) chunks.push(part.text)
    }
    const text = chunks.join("\n").trim()
    if (text) return text
  }
  return ""
}

/** 消息时间：兼容毫秒时间戳、ISO 字符串与 Date。 */
export function messageTime(message: unknown): number {
  const record = isRecord(message) ? message : undefined
  const time = record && isRecord(record.time) ? record.time : undefined
  const created = time?.created
  if (typeof created === "number") return created
  if (typeof created === "string") {
    const parsed = Date.parse(created)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  if (created instanceof Date) return created.getTime()
  return 0
}

/**
 * parent 在某个时刻之后有没有自己产出的消息：通知消息本身不算。
 * 只看时间与来源，不解析正文语义。
 */
export function hasParentActivityAfter(messages: unknown, since: number, childID: string): boolean {
  for (const message of toArray(messages)) {
    const record = isRecord(message) ? message : undefined
    if (!record) continue
    if (messageTime(record) <= since) continue
    const metadata = noticeMetadata(record)
    const source = metadata && typeof metadata.source === "string" ? metadata.source : undefined
    if (source === "superagent-agents" || source === "subagent") continue
    const noticeChild = metadata && typeof metadata.childID === "string" ? metadata.childID : undefined
    if (noticeChild === childID) continue
    return true
  }
  return false
}

/**
 * 判重：这个子会话是否已经收到过完成通知。
 * 认 metadata 的 source + childID，也认正文里的 `<subagent sessionID="...">`。
 */
export function hasNotice(
  messages: unknown,
  options: { childID: string; state?: string | string[]; sources: string[] },
): boolean {
  const states = options.state === undefined ? undefined : Array.isArray(options.state) ? options.state : [options.state]
  const sources = new Set(options.sources)
  for (const message of toArray(messages)) {
    const record = isRecord(message) ? message : undefined
    if (!record) continue
    const metadata = noticeMetadata(record)
    if (metadata) {
      const source = typeof metadata.source === "string" ? metadata.source : undefined
      const childID = typeof metadata.childID === "string" ? metadata.childID : undefined
      const state = typeof metadata.state === "string" ? metadata.state : undefined
      if (source && sources.has(source) && childID === options.childID) {
        if (!states || (state !== undefined && states.includes(state))) return true
      }
    }
    const text = messageText(record)
    if (!text) continue
    const marker = `<subagent sessionID="${options.childID}"`
    const index = text.indexOf(marker)
    if (index < 0) continue
    const end = text.indexOf(">", index)
    const tag = end < 0 ? text.slice(index) : text.slice(index, end)
    if (states) {
      const matched = states.some((state) => tag.includes(`state="${state}"`))
      if (!matched) continue
    }
    return true
  }
  return false
}

/** 运行状态标记的元数据键：子代理回合已结束但后台任务还在跑。 */
export const RUNTIME_METADATA_KEY = "superagent.runtime"
/** 运行状态标记的取值：回合已结束、后台任务仍在跑。 */
export const RUNTIME_STATE_BACKGROUND = "idle-background"

/** 子代理状态监测开关的指令条目键（root 级）。 */
export const STATUS_WATCH_KEY = "superagent.status-watch"

/**
 * 状态监测开关：缺省、非法值一律按启用处理。
 * 只有明确的 false 才停用。
 */
export function statusWatchEnabled(entries: unknown): boolean {
  const entry = toArray(entries).find((item) => isRecord(item) && item.key === STATUS_WATCH_KEY)
  if (!entry) return true
  const value = (entry as Record<string, unknown>).value
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return true
  const text = value.trim().toLowerCase()
  if (text === "false") return false
  return true
}

/* ---------------- 看护、通知与对账 ---------------- */

/** 等原生完成通知落地的等待：原生先到就不重复发。 */
export const NATIVE_NOTICE_WAIT_MS = 1200
/** shell 结束事件后再等一会儿，等消息状态落盘。 */
export const SHELL_SETTLE_DELAY_MS = 300
/** 看护项上限与存活时长。 */
const WATCH_LIMIT = 200
const WATCH_TTL_MS = 6 * 60 * 60 * 1000
/** 对账兜底的总提醒上限。 */
const MAX_REMINDERS = 2
/** 对账周期：默认 60s。 */
export const STATUS_RECONCILE_INTERVAL_MS = 60_000
/** 后台任务全部结束后的收尾文案。 */
const BACKGROUND_DONE_TEXT = "子代理的后台任务已全部结束。"

/** 会话是否仍在执行：有 busy 且没有更新的 idle。 */
export function isSessionBusy(session: unknown): boolean {
  const info = isRecord(session) ? session : undefined
  const time = info && isRecord(info.time) ? info.time : undefined
  const busy = typeof time?.busy === "number" ? time.busy : undefined
  if (busy === undefined) return false
  const idle = typeof time?.idle === "number" ? time.idle : undefined
  return idle === undefined || busy > idle
}

function errorText(cause: unknown) {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function sessionInfo(raw: unknown): Record<string, any> | undefined {
  if (!isRecord(raw)) return undefined
  if (isRecord(raw.data)) return raw.data
  return raw
}

/** 一个子代理的看护项。 */
export type StatusWatch = {
  parentID: string
  rootID?: string
  description: string
  agent: string
  mode: "foreground" | "background"
  /** watch 期望子会话继续跑（后台派发）还是已经收尾。 */
  expected: "running" | "stopped"
  backgroundNotified: boolean
  backgroundSignature?: string
  startedAt: number
  /** 首次看到完成通知的时间；parent 之后一直没动作才补发提醒。 */
  noticeSeenAt?: number
  remindedStates: string[]
}

/** 看护项登记信息。 */
export type StatusWatchInput = {
  childID: string
  parentID: string
  rootID?: string
  description: string
  agent: string
  background: boolean
}

/** 看护器需要的宿主能力：全部由调用方注入，模块本身不碰 ctx。 */
export type StatusWatcherDeps = {
  readSession: (sessionID: string) => Promise<any>
  readMessages: (sessionID: string) => Promise<any[]>
  readEntries: (sessionID: string) => Promise<any[]>
  notifyParent: (input: {
    sessionID: string
    text: string
    description: string
    metadata: Record<string, unknown>
  }) => Promise<void>
  markRuntime: (sessionID: string, background: unknown) => Promise<void>
  clearRuntime: (sessionID: string) => Promise<void>
  write: (record: Record<string, unknown>) => void
  /** 对账周期（毫秒）。 */
  reconcileIntervalMs?: number
}

export type StatusWatcher = {
  /** 派发成功后登记看护项：同一 childID 的 steer 更新而不是重复登记。 */
  register: (input: StatusWatchInput) => Promise<void>
  /** 排队一次收尾：同一 child 串行，永不阻塞事件消费。 */
  settle: (childID: string, options?: { state?: CompletionState; delayMs?: number; force?: boolean }) => void
  /** 周期对账：兜底检查「子代理停了但没人收到完成确认」。 */
  reconcile: () => Promise<void>
  /** 停表并清空看护项。 */
  stop: () => void
  size: () => number
}

/**
 * 子代理状态看护器：登记看护项、按事件收尾、必要时通知 parent，
 * 并用周期对账兜底「子代理停了但没人收到完成确认」。
 */
export function createStatusWatcher(deps: StatusWatcherDeps): StatusWatcher {
  const write = deps.write
  const watches = new Map<string, StatusWatch>()
  /** 同一 child 的 settle 串行执行，避免并发重复通知。 */
  const settleChains = new Map<string, Promise<void>>()
  /** parent → 上次提醒时的活动时间：parent 之后动过就不再打扰。 */
  const parentReminderBaseline = new Map<string, number>()
  let reminderTotal = 0
  let reconcileTimer: ReturnType<typeof setInterval> | undefined
  /** dispose 后不再投递迟到通知；旧实例的异步收尾不能打扰新实例。 */
  let stopped = false

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  /** 状态监测开关（root 级）：缺省与非法值一律按启用处理。 */
  const watchEnabledFor = async (rootID: string | undefined, fallbackID: string) => {
    const id = rootID ?? fallbackID
    if (!id) return true
    try {
      return statusWatchEnabled(await deps.readEntries(id))
    } catch (cause) {
      write({
        event: "status-watch-read-failed",
        decision: "allow",
        sessionID: id,
        note: "开关读取失败，按启用处理",
        cause: errorText(cause),
      })
      return true
    }
  }

  /** parent 的最近活动时间：消息时间与最近一次执行开始时间取大者。 */
  const parentActivity = async (parentID: string) => {
    try {
      const messages = await deps.readMessages(parentID)
      let latest = 0
      for (const message of messages) {
        const at = messageTime(message)
        if (at > latest) latest = at
      }
      const info = sessionInfo(await deps.readSession(parentID))
      const busy = isRecord(info) && isRecord(info.time) && typeof info.time.busy === "number" ? info.time.busy : 0
      return Math.max(latest, busy)
    } catch {
      return 0
    }
  }

  const stopReconcileTimer = () => {
    if (!reconcileTimer) return
    clearInterval(reconcileTimer)
    reconcileTimer = undefined
  }

  /** 只有还有 watch 时才走表；watch 清空立即停表。 */
  const ensureReconcileTimer = () => {
    if (watches.size === 0) {
      stopReconcileTimer()
      return
    }
    if (reconcileTimer) return
    reconcileTimer = setInterval(() => {
      void reconcile().catch((cause) =>
        write({ event: "status-notify-failed", decision: "error", phase: "reconcile", cause: errorText(cause) }),
      )
    }, deps.reconcileIntervalMs ?? STATUS_RECONCILE_INTERVAL_MS)
    ;(reconcileTimer as any)?.unref?.()
  }

  /** 通知 parent：子代理回合已结束但后台任务还在跑。 */
  const notifyBackground = async (childID: string, watch: StatusWatch, jobs: BackgroundJob[]) => {
    const text = formatBackgroundNotice({ childID, description: watch.description, jobs })
    try {
      await deps.notifyParent({
        sessionID: watch.parentID,
        text,
        description: "子代理后台任务",
        metadata: { source: "superagent-agents", childID, state: RUNTIME_STATE_BACKGROUND },
      })
    } catch (cause) {
      write({
        event: "status-notify-failed",
        decision: "error",
        phase: "background",
        childSessionID: childID,
        cause: errorText(cause),
      })
      return false
    }
    try {
      await deps.markRuntime(childID, jobs)
    } catch (cause) {
      write({
        event: "status-notify-failed",
        decision: "error",
        phase: "runtime-mark",
        childSessionID: childID,
        cause: errorText(cause),
      })
    }
    write({
      event: "status-background",
      decision: "allow",
      childSessionID: childID,
      parentID: watch.parentID,
      jobs: jobs.length,
    })
    return true
  }

  /** 通知 parent：子代理完成、失败或中断。 */
  const notifyCompletion = async (
    childID: string,
    watch: StatusWatch,
    state: CompletionState,
    text: string,
  ) => {
    const body = formatCompletionNotice({ childID, description: watch.description, state, text })
    try {
      await deps.notifyParent({
        sessionID: watch.parentID,
        text: body,
        description: "子代理完成通知",
        metadata: { source: "superagent-agents", childID, state },
      })
    } catch (cause) {
      write({
        event: "status-notify-failed",
        decision: "error",
        phase: "completion",
        childSessionID: childID,
        cause: errorText(cause),
      })
      return false
    }
    write({
      event: "status-completed",
      decision: "allow",
      childSessionID: childID,
      parentID: watch.parentID,
      state,
    })
    return true
  }

  /** 对账兜底的提醒：子代理停了但一直没收到完成确认。 */
  const notifyReminder = async (childID: string, watch: StatusWatch, state: CompletionState) => {
    const text = formatWatchReminder({ childID, state })
    try {
      await deps.notifyParent({
        sessionID: watch.parentID,
        text,
        description: "子代理状态监测",
        metadata: { source: "superagent-agents", childID, state: "watch-reminder" },
      })
    } catch (cause) {
      write({
        event: "status-notify-failed",
        decision: "error",
        phase: "reminder",
        childSessionID: childID,
        cause: errorText(cause),
      })
      return false
    }
    write({
      event: "status-reminder",
      decision: "allow",
      childSessionID: childID,
      parentID: watch.parentID,
      state,
    })
    return true
  }

  const defaultCompletionText = (state: CompletionState) =>
    state === "error"
      ? "子代理执行失败，未取到最终输出。"
      : state === "cancelled"
        ? "子代理被中断，未取到最终输出。"
        : "子代理已结束，未取到最终输出。"

  /** 收尾一次看护项：判断后台任务、决定通知、清理标记。 */
  const settleStatus = async (
    childID: string,
    options: { state?: CompletionState; delayMs?: number; force?: boolean } = {},
  ) => {
    if (stopped) return
    const watch = watches.get(childID)
    if (!watch) return
    if (options.delayMs) await delay(options.delayMs)
    if (stopped) return
    const info = sessionInfo(await deps.readSession(childID))
    if (!info) return
    // 还在跑就等下一个事件；前台派发时工具已经返回，回合一定结束了。
    if (isSessionBusy(info) && !options.force) {
      watch.expected = "running"
      return
    }
    const messages = await deps.readMessages(childID)
    const jobs = collectBackgroundJobs(messages)
    if (jobs.length > 0) {
      const signature = jobSignature(jobs)
      if (watch.backgroundSignature !== signature) {
        const sent = await notifyBackground(childID, watch, jobs)
        if (sent) {
          watch.backgroundNotified = true
          watch.backgroundSignature = signature
          watch.noticeSeenAt = Date.now()
        }
      }
      return
    }
    const state = options.state ?? completionState(info.outcome) ?? "completed"
    if (watch.mode === "background") {
      // 等原生通知落地；原生已通知过就不重复发。
      await delay(NATIVE_NOTICE_WAIT_MS)
      let parentMessages: any[] = []
      try {
        parentMessages = await deps.readMessages(watch.parentID)
      } catch {
        parentMessages = []
      }
      const seen = hasNotice(parentMessages, {
        childID,
        state: noticeStates(state),
        sources: ["subagent", "superagent-agents"],
      })
      if (!seen) {
        const text = finalAssistantText(messages) || defaultCompletionText(state)
        const sent = await notifyCompletion(childID, watch, state, text)
        if (!sent) return
      }
      watch.noticeSeenAt = Date.now()
    } else if (watch.backgroundNotified) {
      // 前台派发：工具结果已经回传，只在先前提过后台任务时补一条收尾通知。
      const sent = await notifyCompletion(childID, watch, state, BACKGROUND_DONE_TEXT)
      if (!sent) return
      watch.noticeSeenAt = Date.now()
    }
    try {
      await deps.clearRuntime(childID)
    } catch (cause) {
      write({
        event: "status-notify-failed",
        decision: "error",
        phase: "runtime-clear",
        childSessionID: childID,
        cause: errorText(cause),
      })
    }
    watches.delete(childID)
    if (watches.size === 0) stopReconcileTimer()
  }

  /** 排队一次收尾：同一 child 串行，永不阻塞事件消费。 */
  const settle = (
    childID: string,
    options: { state?: CompletionState; delayMs?: number; force?: boolean } = {},
  ) => {
    const previous = settleChains.get(childID) ?? Promise.resolve()
    const next = previous
      .then(() => settleStatus(childID, options))
      .catch((cause) =>
        write({
          event: "status-notify-failed",
          decision: "error",
          phase: "settle",
          childSessionID: childID,
          cause: errorText(cause),
        }),
      )
    settleChains.set(childID, next)
    void next.finally(() => {
      if (settleChains.get(childID) === next) settleChains.delete(childID)
    })
  }

  /** 周期对账：兜底检查「子代理停了但没人收到完成确认」。 */
  const reconcile = async () => {
    if (watches.size === 0) {
      stopReconcileTimer()
      return
    }
    const now = Date.now()
    for (const [childID, watch] of [...watches.entries()]) {
      if (now - watch.startedAt > WATCH_TTL_MS) {
        watches.delete(childID)
        continue
      }
      if (!(await watchEnabledFor(watch.rootID, watch.parentID))) {
        watches.delete(childID)
        continue
      }
      // 只对后台派发兜底；前台派发的工具结果已经回传给模型，不能再补提醒。
      if (watch.mode !== "background" || watch.expected !== "running") continue
      let info: Record<string, any> | undefined
      try {
        info = sessionInfo(await deps.readSession(childID))
      } catch {
        continue
      }
      if (!info) continue
      if (isSessionBusy(info)) continue
      // 回合停了但后台任务还在跑：这不是“没人收到完成确认”，先补后台通知，
      // 不能发“已停止，请验收”的提醒去误导主会话。
      let childMessages: any[] = []
      try {
        childMessages = await deps.readMessages(childID)
      } catch {
        childMessages = []
      }
      if (collectBackgroundJobs(childMessages).length > 0) {
        settle(childID, { force: true })
        continue
      }
      const state = completionState(info.outcome) ?? "completed"
      if (watch.remindedStates.includes(state)) continue
      if (reminderTotal >= MAX_REMINDERS) break
      let parentMessages: any[] = []
      try {
        parentMessages = await deps.readMessages(watch.parentID)
      } catch {
        continue
      }
      const activity = await parentActivity(watch.parentID)
      // parent 自上次提醒之后动过：它已经在处理，不再打扰。
      const baseline = parentReminderBaseline.get(watch.parentID)
      if (baseline !== undefined && activity > baseline) continue
      const noticed = hasNotice(parentMessages, {
        childID,
        state: noticeStates(state),
        sources: ["subagent", "superagent-agents"],
      })
      if (noticed) {
        // 刚发现通知：先给 parent 一次反应机会，下一轮再判断它有没有动。
        if (watch.noticeSeenAt === undefined) {
          watch.noticeSeenAt = now
          continue
        }
        if (hasParentActivityAfter(parentMessages, watch.noticeSeenAt, childID)) continue
      }
      // parent 正在跑就等它空闲。
      let parentInfo: Record<string, any> | undefined
      try {
        parentInfo = sessionInfo(await deps.readSession(watch.parentID))
      } catch {
        continue
      }
      if (parentInfo && isSessionBusy(parentInfo)) continue
      const sent = await notifyReminder(childID, watch, state)
      if (!sent) continue
      watch.remindedStates.push(state)
      watch.noticeSeenAt = watch.noticeSeenAt ?? now
      reminderTotal += 1
      parentReminderBaseline.set(watch.parentID, await parentActivity(watch.parentID))
    }
    if (watches.size === 0) stopReconcileTimer()
  }

  /** 登记看护项：同一 childID 的 steer 更新而不是重复登记。 */
  const register = async (input: StatusWatchInput) => {
    if (stopped) return
    if (!(await watchEnabledFor(input.rootID, input.parentID))) {
      write({
        event: "status-watch-disabled",
        decision: "allow",
        childSessionID: input.childID,
        parentID: input.parentID,
      })
      return
    }
    const existing = watches.get(input.childID)
    const watch: StatusWatch = existing ?? {
      parentID: input.parentID,
      description: input.description,
      agent: input.agent,
      mode: "foreground",
      expected: "stopped",
      backgroundNotified: false,
      startedAt: Date.now(),
      remindedStates: [],
    }
    watch.parentID = input.parentID
    watch.rootID = input.rootID ?? watch.rootID
    watch.description = input.description || watch.description
    watch.agent = input.agent || watch.agent
    watch.mode = input.background ? "background" : "foreground"
    watch.expected = input.background ? "running" : "stopped"
    watches.set(input.childID, watch)
    // 看护项上限：超出后淘汰最旧的一条。
    while (watches.size > WATCH_LIMIT) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, item] of watches) {
        if (item.startedAt < oldestAt) {
          oldestAt = item.startedAt
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      watches.delete(oldestKey)
    }
    ensureReconcileTimer()
    // 前台派发时工具已经返回，回合已结束；后台派发等子会话自己的结束事件。
    settle(input.childID, { force: !input.background })
  }

  const stop = () => {
    stopped = true
    stopReconcileTimer()
    watches.clear()
    settleChains.clear()
  }

  return { register, settle, reconcile, stop, size: () => watches.size }
}
