/**
 * 面板手动操作回传：用户在「agents协作」面板上的每一次编排动作，都向当前 root
 * 会话投递一条 synthetic 通知，明确「这是用户手动做的、做了什么、对后续意味着什么」。
 *
 * 只做文案与投递，不改变操作本身：投递失败只回 toast，不回滚用户的操作。
 * 通知一律以 queue 投递：成为对话里的一条待处理消息，由宿主在合适的回合带入，
 * 不主动 steer 或唤醒正在推理的会话。
 *
 * 通知与「子代理状态监测」开关无关：那个开关只控制自动状态监测。
 */

/** 会被回传的面板手动操作。`setting` 是通用设置项（报告风格、提示词、开关等）。 */
export type ManualOpAction =
  | "keep"
  | "unkeep"
  | "compact"
  | "delete"
  | "oversight"
  | "collab"
  | "max-subagents"
  | "max-flagship"
  | "model"
  | "default-policy"
  | "child-policy"
  | "setting"

/** 一次手动操作的细节：作用对象与生效值。 */
export type ManualOpDetail = {
  /** 被操作的子代理会话 ID。 */
  childID?: string
  /** 被操作的子代理标题。 */
  childTitle?: string
  /** 生效值：新的上限、监管等级、设置项取值等。 */
  value?: string
  /** `setting` 动作的设置项名称。 */
  label?: string
  /** 调小旗舰上限时，本次实际切到默认模型的旗舰数。 */
  switched?: number
  /** 调小旗舰上限时，本次跳过（同模型、目标缺失/不可用或切换失败）的旗舰数。 */
  skipped?: number
  /** 默认模型策略：auto 只影响后续分配，inherit/fixed 保存后由批量同步执行。 */
  policy?: "auto" | "inherit" | "fixed"
}

const PREFIX = "[superagent] "

/** 子代理的称呼：标题 + 会话 ID，缺标题时只写会话 ID。 */
function subject(detail: ManualOpDetail): string {
  const title = detail.childTitle?.trim()
  const id = detail.childID?.trim()
  if (title && id) return `${title}（${id}）`
  if (title) return title
  return id ? `（${id}）` : "子代理"
}

/** 回传正文的最大长度（字符）。 */
export const MAX_MANUAL_OP_LENGTH = 1000

/** 手动操作通知的聚合窗口（毫秒）：窗口内的非立即操作合并成一条。 */
export const MANUAL_NOTIFY_DEBOUNCE_MS = 800

/** 通知正文：不含 `[superagent] ` 前缀，供单条与聚合共用。 */
function manualOpBody(action: ManualOpAction, detail: ManualOpDetail = {}): string {
  const who = subject(detail)
  const value = detail.value?.trim()
  switch (action) {
    case "delete":
      return `用户在面板手动删除了子代理 ${who}。这不是你的指令；该子会话与上下文已不可恢复，相关任务如仍需要请重新派发。`
    case "compact":
      return `用户在面板对子代理 ${who} 发起了原生上下文压缩。这不是你的指令；ctx 读数随后下降是预期行为，不要误判为上下文丢失。`
    case "keep":
      return `用户在面板为子代理 ${who} 开启了保护。这不是你的指令；它不会被自动淘汰，但默认模型同步仍会作用于它，需要继续任务请直接续跑它。`
    case "unkeep":
      return `用户在面板解除了子代理 ${who} 的保护。这不是你的指令；它重新可以被自动淘汰，模型也可以被修改。`
    case "oversight":
      return `用户在面板把子代理 ${who} 的监管等级调整为${value ?? "新等级"}。这不是你的指令；该子代理的报告与验收按这个等级执行。`
    case "collab":
      return value === "停用"
        ? "用户在面板停用了本会话的协作模式总开关。这不是你的指令；硬拦截、限额自动切换、critic 复核、状态探针与上下文自动压缩全部停止，插件不再替你管编排。"
        : "用户在面板启用了本会话的协作模式总开关。这不是你的指令；硬拦截、限额自动切换、critic 复核、状态探针与上下文自动压缩都恢复生效。"
    case "max-subagents":
      return `用户在面板把子代理数量上限改为${value ?? "新上限"}。这不是你的指令；超出后会自动淘汰最旧的已完成子代理，运行中与已保护的不会被删。`
    case "max-flagship": {
      const counts =
        detail.switched !== undefined || detail.skipped !== undefined
          ? `；本次调小后已切换 ${detail.switched ?? 0} 个、跳过 ${detail.skipped ?? 0} 个现有旗舰`
          : ""
      return `用户在面板把旗舰子代理数量上限改为${value ?? "新上限"}${counts}。这不是你的指令；降额通过把超额旗舰切到子代理默认模型实现，不删除会话，官方切换不中断当前步骤，运行中的旗舰当前步骤继续、后续步骤使用新模型；之后新建显式旗舰超过上限时仍按准入规则拒绝或淘汰最旧的已完成旗舰。`
    }
    case "model":
      return `用户在面板手动把子代理 ${who} 的模型切换为${value ?? "新模型"}。这不是你的指令；这是官方直接切换，不中断当前步骤，当前步骤继续，后续步骤使用新模型，不要因此重试、报警或重新派发。`
    case "default-policy": {
      const policy = detail.policy
      if (policy === "auto") {
        return "用户在面板把子代理默认模型设为自动。这不是你的指令；该策略只决定后续分配由 Superagent 选择模型，现有子代理没有被批量切换，不要据此认为模型已生效。"
      }
      if (policy === "inherit") {
        return "用户在面板把子代理默认模型设为跟随会话。这不是你的指令；策略已保存，后续分配与默认同步使用当前会话模型，运行中的子代理当前步骤继续、后续步骤使用新模型；这不表示现有子代理都已切换成功。"
      }
      return `用户在面板把子代理默认模型设为${value ?? "新模型"}。这不是你的指令；策略已保存，后续分配与默认同步使用该模型，运行中的子代理当前步骤继续、后续步骤使用新模型；现有子代理的批量切换结果以面板提示为准，不表示全部已生效。`
    }
    case "child-policy": {
      const policy = detail.policy
      const scope = "这不是你的指令；只影响该子代理后续分配，不改变全局默认模型，也不批量切换现有子代理。"
      if (policy === "auto") {
        return `用户在面板把子代理 ${who} 的模型策略设为自动。${scope}`
      }
      if (policy === "inherit") {
        return `用户在面板把子代理 ${who} 的模型策略设为跟随会话。${scope}`
      }
      return `用户在面板把子代理 ${who} 的模型策略设为固定模型。${scope}`
    }
    case "setting": {
      const label = detail.label?.trim() || "面板设置"
      return `用户在面板把「${label}」调整为${value ?? "新值"}。这不是你的指令；该设置已保存并生效，后续按这个值执行。`
    }
  }
}

function bounded(text: string): string {
  return text.length > MAX_MANUAL_OP_LENGTH ? `${text.slice(0, MAX_MANUAL_OP_LENGTH - 1)}…` : text
}

/**
 * 手动操作的回传文案：一段中文，主语是「用户」，结尾给一句对 Superagent 的提示。
 */
export function manualOpText(action: ManualOpAction, detail: ManualOpDetail = {}): string {
  return bounded(`${PREFIX}${manualOpBody(action, detail)}`)
}

/** 聚合窗口内的多条操作合成一条正文：一条 synthetic 明说这一轮用户做了什么。 */
export function manualOpBatchText(entries: ReadonlyArray<{ action: ManualOpAction; detail?: ManualOpDetail }>): string {
  if (entries.length === 0) return ""
  if (entries.length === 1) return manualOpText(entries[0]!.action, entries[0]!.detail)
  const bodies = entries.map((entry) => manualOpBody(entry.action, entry.detail))
  return bounded(
    `${PREFIX}用户在本轮面板连续做了以下手动操作，都不是你的指令：\n${bodies.map((body) => `- ${body}`).join("\n")}`,
  )
}

/**
 * 把一次手动操作通知到 root 会话。
 * 缺 root、宿主没有 synthetic、或投递失败时返回 false，绝不向上抛。
 */
export async function notifyManualOp(
  context: any,
  input: {
    rootID?: string
    childID?: string
    childTitle?: string
    action: ManualOpAction
    detail?: ManualOpDetail
  },
): Promise<boolean> {
  if (!input.rootID) return false
  const detail: ManualOpDetail = { ...input.detail }
  if (input.childID) detail.childID = input.childID
  if (input.childTitle) detail.childTitle = input.childTitle
  return deliverBatch(context, input.rootID, [{ action: input.action, detail }])
}

/** 一条通知的投递：合并正文、metadata 与 queue 语义都在这里收口。 */
async function deliverBatch(
  context: any,
  rootID: string,
  entries: ReadonlyArray<{ action: ManualOpAction; detail: ManualOpDetail }>,
): Promise<boolean> {
  try {
    const synthetic = context?.client?.session?.synthetic
    if (typeof synthetic !== "function") return false
    const metadata: Record<string, unknown> = {
      source: "superagent-agents",
      kind: "manual-op",
      action: entries.length === 1 ? entries[0]!.action : "batch",
    }
    if (entries.length > 1) metadata.actions = entries.map((entry) => entry.action)
    const childIDs = new Set(entries.map((entry) => entry.detail.childID).filter(Boolean))
    if (childIDs.size === 1) metadata.childID = [...childIDs][0]
    await synthetic.call(context.client.session, {
      sessionID: rootID,
      text: manualOpBatchText(entries),
      description: "用户手动操作",
      metadata,
      // 一律排队：通知成为对话里的一条待处理消息，由宿主在下一个合适回合带入。
      // 不 steer、不 resume，绝不打断或唤醒正在推理的会话。
      delivery: "queue",
    })
    return true
  } catch {
    return false
  }
}

/** 一次手动操作通知的输入。 */
export type ManualNotifierInput = {
  action: ManualOpAction
  childID?: string
  childTitle?: string
  detail?: ManualOpDetail
}

/** 手动操作通知器：聚合窗口、合并与投递。 */
export type ManualNotifier = {
  /**
   * 投递一次手动操作通知。
   * 返回 false 只表示「真的投递失败」——被同组后来的操作合并、或没有 root
   * 可投，都算成功路径，不打扰用户。
   */
  notify: (input: ManualNotifierInput, options?: { immediate?: boolean }) => Promise<boolean>
  /** 面板卸载时调用：对已发生的 pending 做一次 best-effort 聚合投递，不抛。 */
  dispose: () => void
}

/**
 * 聚合分组：同一组里的连续操作只留最后一条；delete/compact/collab/model 不进组，
 * 立即动作只跳过等待（仍先 flush 已在窗口里的操作，再 queue 投递）。
 */
function groupKey(action: ManualOpAction, detail: ManualOpDetail): string | undefined {
  if (action === "keep" || action === "unkeep") return `keep:${detail.childID ?? ""}`
  if (action === "oversight") return `oversight:${detail.childID ?? ""}`
  if (action === "max-subagents") return "max-subagents"
  if (action === "max-flagship") return "max-flagship"
  if (action === "default-policy") return "default-policy"
  if (action === "setting") return `setting:${detail.label ?? ""}`
  return undefined
}

/**
 * 手动操作通知器：非立即操作共用一个聚合窗口，窗口内不同操作用一条 synthetic
 * 一起回传；立即操作先冲刷窗口，再单独 queue 投递。
 */
export function createManualNotifier(
  context: any,
  options: { rootID: () => string | undefined; delayMs?: number },
): ManualNotifier {
  const delayMs = options.delayMs ?? MANUAL_NOTIFY_DEBOUNCE_MS
  type PendingEntry = { action: ManualOpAction; detail: ManualOpDetail; key?: string; resolve: (value: boolean) => void }
  let pending: { entries: PendingEntry[]; timer: ReturnType<typeof setTimeout> } | undefined
  let disposed = false
  /** 立即操作的投递链：先点的先投递，不与窗口冲刷交错。 */
  let queueTail: Promise<unknown> = Promise.resolve()

  const deliver = (entries: Array<{ action: ManualOpAction; detail: ManualOpDetail }>): Promise<boolean> => {
    const rootID = options.rootID()
    // 没有 root 会话就无处可投：跳过，不当作失败。
    if (!rootID) return Promise.resolve(true)
    return deliverBatch(context, rootID, entries)
  }

  const flush = async (): Promise<void> => {
    if (!pending) return
    const batch = pending
    pending = undefined
    clearTimeout(batch.timer)
    const ok = await deliver(batch.entries)
    for (const entry of batch.entries) entry.resolve(ok)
  }

  const notify = (input: ManualNotifierInput, notifyOptions: { immediate?: boolean } = {}): Promise<boolean> => {
    if (disposed) return Promise.resolve(true)
    const detail: ManualOpDetail = { ...input.detail }
    if (input.childID) detail.childID = input.childID
    if (input.childTitle) detail.childTitle = input.childTitle
    const key = groupKey(input.action, detail)
    if (notifyOptions.immediate || !key) {
      // 立即动作先冲刷窗口，并串到同一条投递链上：先前设置已经成功写入，
      // 不能因为用户紧接着点删除就丢，也不能让两次立即操作并发乱序。
      const run: Promise<boolean> = queueTail
        .then(() => flush())
        .then(() => (disposed ? true : deliver([{ action: input.action, detail }])))
      queueTail = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }
    return new Promise<boolean>((resolve) => {
      if (!pending) {
        const batch: { entries: PendingEntry[]; timer: ReturnType<typeof setTimeout> } = {
          entries: [],
          timer: undefined as never,
        }
        batch.timer = setTimeout(() => {
          void flush()
        }, delayMs)
        pending = batch
      }
      const batch = pending
      const existing = batch.entries.findIndex((entry) => entry.key === key)
      if (existing >= 0) {
        const [previous] = batch.entries.splice(existing, 1)
        // 同组后来的操作覆盖前一条：前一条按「已被合并」收口，不当作失败。
        previous!.resolve(true)
      }
      batch.entries.push({ action: input.action, detail, key, resolve })
      // 连续操作滚动窗口：最后一次动作之后 800ms 才统一发出。
      clearTimeout(batch.timer)
      batch.timer = setTimeout(() => {
        void flush()
      }, delayMs)
    })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (!pending) return
    const batch = pending
    pending = undefined
    clearTimeout(batch.timer)
    // 卸载时窗口里的手动操作已经发生：尽力补发一次聚合通知，不让它随面板消失。
    // 投递本身 fail-open（无 root 视为成功、宿主失败返回 false），这里不抛。
    void deliver(batch.entries).then(
      (ok) => {
        for (const entry of batch.entries) entry.resolve(ok)
      },
      () => {
        for (const entry of batch.entries) entry.resolve(true)
      },
    )
  }

  return { notify, dispose }
}
