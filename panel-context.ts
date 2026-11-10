/** TUI 面板的上下文用量读数：token 口径与格式化。 */

import { DEFAULT_CONTEXT_WARN_TOKENS, contextWarnThreshold } from "./context-policy"

/** 上下文偏长的提示阈值：子代理当前上下文超过它就把读数染成警示色。 */
export const CONTEXT_WARN_TOKENS = DEFAULT_CONTEXT_WARN_TOKENS

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

/**
 * 信息行里的上下文读数：无数据返回 undefined，严格超过阈值带上警示标记。
 * 传入模型时按它的上下文窗口收紧阈值；不传模型/阈值保持 300K 旧行为。
 */
export function contextUsageView(
  messages: ReadonlyArray<ContextMessage> | undefined,
  model?: unknown,
  threshold?: number,
) {
  const tokens = contextTokens(messages)
  if (tokens === undefined) return undefined
  const limit = threshold ?? contextWarnThreshold(model)
  return { tokens, text: `ctx ${formatTokenCount(tokens)}`, warning: tokens > limit }
}
