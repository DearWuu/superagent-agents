/**
 * 面板手动操作回传：用户在「agents协作」面板上的每一次编排动作，都向当前 root
 * 会话投递一条 synthetic 通知，明确「这是用户手动做的、做了什么、对后续意味着什么」。
 *
 * 只做文案与投递，不改变操作本身：投递失败只回 toast，不回滚用户的操作。
 * 模型切换不在此列——面板与既有模型标记已经能看出差异，不需要额外提醒。
 */

/** 会被回传的面板手动操作。 */
export type ManualOpAction =
  | "keep"
  | "unkeep"
  | "compact"
  | "delete"
  | "oversight"
  | "collab"
  | "max-subagents"
  | "max-flagship"

/** 一次手动操作的细节：作用对象与生效值。 */
export type ManualOpDetail = {
  /** 被操作的子代理会话 ID。 */
  childID?: string
  /** 被操作的子代理标题。 */
  childTitle?: string
  /** 生效值：新的上限、监管等级等。 */
  value?: string
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

/** 手动操作通知的防抖窗口（毫秒）：连续操作只发最后一条。 */
export const MANUAL_NOTIFY_DEBOUNCE_MS = 800

/**
 * 手动操作的回传文案：一段中文，主语是「用户」，结尾给一句对 Superagent 的提示。
 */
export function manualOpText(action: ManualOpAction, detail: ManualOpDetail = {}): string {
  const who = subject(detail)
  const value = detail.value?.trim()
  let body: string
  switch (action) {
    case "delete":
      body = `用户在面板手动删除了子代理 ${who}。这不是你的指令；该子会话与上下文已不可恢复，相关任务如仍需要请重新派发。`
      break
    case "compact":
      body = `用户在面板对子代理 ${who} 发起了原生上下文压缩。这不是你的指令；ctx 读数随后下降是预期行为，不要误判为上下文丢失。`
      break
    case "keep":
      body = `用户在面板为子代理 ${who} 开启了保护。这不是你的指令；它不会被自动淘汰，模型也不会被批量修改，需要继续任务请直接续跑它。`
      break
    case "unkeep":
      body = `用户在面板解除了子代理 ${who} 的保护。这不是你的指令；它重新可以被自动淘汰，模型也可以被修改。`
      break
    case "oversight":
      body = `用户在面板把子代理 ${who} 的监管等级调整为${value ?? "新等级"}。这不是你的指令；该子代理的报告与验收按这个等级执行。`
      break
    case "collab":
      body =
        value === "停用"
          ? "用户在面板停用了本会话的协作模式总开关。这不是你的指令；硬拦截、限额自动切换、critic 复核、状态探针与上下文自动压缩全部停止，插件不再替你管编排。"
          : "用户在面板启用了本会话的协作模式总开关。这不是你的指令；硬拦截、限额自动切换、critic 复核、状态探针与上下文自动压缩都恢复生效。"
      break
    case "max-subagents":
      body = `用户在面板把子代理数量上限改为${value ?? "新上限"}。这不是你的指令；超出后会自动淘汰最旧的已完成子代理，运行中与已保护的不会被删。`
      break
    case "max-flagship":
      body = `用户在面板把旗舰子代理数量上限改为${value ?? "新上限"}。这不是你的指令；它只约束与 Superagent 同款模型的显式委派，超限时先淘汰最旧的已完成旗舰，运行中与受保护的不删。`
      break
  }
  const text = `${PREFIX}${body}`
  return text.length > MAX_MANUAL_OP_LENGTH ? `${text.slice(0, MAX_MANUAL_OP_LENGTH - 1)}…` : text
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
  try {
    if (!input.rootID) return false
    const synthetic = context?.client?.session?.synthetic
    if (typeof synthetic !== "function") return false
    const detail: ManualOpDetail = { ...input.detail }
    if (input.childID) detail.childID = input.childID
    if (input.childTitle) detail.childTitle = input.childTitle
    const metadata: Record<string, unknown> = {
      source: "superagent-agents",
      kind: "manual-op",
      action: input.action,
    }
    if (detail.childID) metadata.childID = detail.childID
    await synthetic.call(context.client.session, {
      sessionID: input.rootID,
      text: manualOpText(input.action, detail),
      description: "用户手动操作",
      metadata,
      // 手动操作不插当前轮：排队到下一轮，避免打断正在进行的推理。
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

/** 手动操作通知器：开关、防抖与投递。 */
export type ManualNotifier = {
  /**
   * 投递一次手动操作通知。
   * 返回 false 只表示「真的投递失败」——开关关闭与被同组后来的操作合并都算成功路径，不打扰用户。
   */
  notify: (input: ManualNotifierInput, options?: { immediate?: boolean }) => Promise<boolean>
  /** 取消待发通知：面板卸载时调用。 */
  dispose: () => void
}

/** 防抖分组：同一组里的连续操作只发最后一条；delete/compact/collab 不进组。 */
function debounceKey(action: ManualOpAction, childID?: string): string | undefined {
  if (action === "keep" || action === "unkeep") return `keep:${childID ?? ""}`
  if (action === "oversight") return `oversight:${childID ?? ""}`
  if (action === "max-subagents") return "max-subagents"
  if (action === "max-flagship") return "max-flagship"
  return undefined
}

/**
 * 手动操作通知器：受「子代理状态监测」开关控制，连续操作防抖合并，
 * delete/compact/collab 立即发送。
 */
export function createManualNotifier(
  context: any,
  options: { rootID: () => string | undefined; enabled: () => boolean; delayMs?: number },
): ManualNotifier {
  const delayMs = options.delayMs ?? MANUAL_NOTIFY_DEBOUNCE_MS
  /** 待发的防抖通知：同一 key 只留最后一条。 */
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; resolve: (value: boolean) => void }>()
  let disposed = false

  const send = async (input: ManualNotifierInput): Promise<boolean> => {
    const rootID = options.rootID()
    // 没有 root 会话就无处可投：跳过，不当作失败。
    if (!rootID) return true
    return notifyManualOp(context, {
      rootID,
      childID: input.childID,
      childTitle: input.childTitle,
      action: input.action,
      detail: input.detail,
    })
  }

  const notify = (input: ManualNotifierInput, notifyOptions: { immediate?: boolean } = {}): Promise<boolean> => {
    if (disposed) return Promise.resolve(true)
    if (!options.enabled()) return Promise.resolve(true)
    const key = notifyOptions.immediate ? undefined : debounceKey(input.action, input.childID)
    if (!key) return send(input)
    return new Promise<boolean>((resolve) => {
      const existing = pending.get(key)
      if (existing) {
        clearTimeout(existing.timer)
        // 同组后来的操作会覆盖前一条：前一条按「已被合并」收口，不当作失败。
        existing.resolve(true)
      }
      const timer = setTimeout(() => {
        pending.delete(key)
        void send(input).then(resolve, () => resolve(false))
      }, delayMs)
      pending.set(key, { timer, resolve })
    })
  }

  const dispose = () => {
    disposed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve(true)
    }
    pending.clear()
  }

  return { notify, dispose }
}
