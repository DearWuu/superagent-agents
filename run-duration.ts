/**
 * 子代理运行时长与超时警示：纯展示逻辑，和服务端未来的超时自动状态探针
 * 共用同一阈值语义（30 分钟）。这里只产生文案，不中断、不淘汰任何会话。
 */

/** 超时警示阈值：运行超过 30 分钟即标记。 */
export const LONG_RUNNING_THRESHOLD_MS = 30 * 60 * 1000

/** 运行时长文案：分钟取整，满一小时后写成 1h23m。 */
export function formatRunDuration(elapsedMs: number) {
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

type SessionStatusInfo = {
  outcome?: string
  time?: { busy?: number; idle?: number }
}

/**
 * 是否仍在执行。活跃执行集合是唯一权威信号，与原生 Subagents 面板同源
 * （`data.session.status()` 背后的 `/api/session/active`）：会话被取消后重启
 * 仍在跑时，残留的 `outcome` 不得把它标成结束态。
 */
export function sessionRunning(active: boolean) {
  return active
}

/** 结束结果只在会话已离开活跃集合之后才算数。 */
export function sessionEnded(info: SessionStatusInfo | undefined, active: boolean) {
  return !active && Boolean(info?.outcome)
}

/** 旧数据没有活跃标记时，用 busy/idle 时间戳判断是否曾有未收尾的执行。 */
function inferredRunning(info: SessionStatusInfo | undefined) {
  const busy = info?.time?.busy
  if (busy === undefined) return false
  const idle = info?.time?.idle
  return idle === undefined || busy > idle
}

export type SessionStatusView = {
  glyph: string
  text: string
  longRunning: boolean
}

/**
 * 一行的状态。优先级：活跃执行集合 → 结束结果 → busy/idle 时间戳兜底。
 * 只有运行中的行显示时长；root 行与结束态不显示。
 */
export function sessionStatusView(
  info: SessionStatusInfo | undefined,
  running: boolean,
  options: { now: number; duration: boolean },
): SessionStatusView {
  const outcome = info?.outcome
  const busy = info?.time?.busy
  if (sessionRunning(running) || (!outcome && inferredRunning(info))) {
    if (!options.duration || busy === undefined) return { glyph: "●", text: "进行中", longRunning: false }
    const elapsed = Math.max(0, options.now - busy)
    const longRunning = elapsed >= LONG_RUNNING_THRESHOLD_MS
    const suffix = longRunning ? " ⚠" : ""
    return { glyph: "●", text: `进行中 ${formatRunDuration(elapsed)}${suffix}`, longRunning }
  }
  if (sessionEnded(info, running)) {
    if (outcome === "succeeded") return { glyph: "✓", text: "已完成", longRunning: false }
    if (outcome === "failed") return { glyph: "✗", text: "失败", longRunning: false }
    return { glyph: "Ⅱ", text: "已中断", longRunning: false }
  }
  return { glyph: "○", text: "等待中", longRunning: false }
}