/** TUI 面板的纯显示工具：宽度/截断、状态、模型标签与树节点标注。 */

import type { Plugin } from "@opencode/plugin/tui"
import { modelKey, type ModelRef } from "./model-policy"
import { type AgentNode, type ModelView, type SessionInput } from "./agent-tree"
import { sessionStatusView } from "./run-duration"
import type { RootSettings } from "./session-scope"
import type { ModelInfo, SessionInfo } from "./panel-types"

export const key = (model: ModelRef) =>
  `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
export const isFreeModel = (model: ModelInfo) => Boolean(model.cost?.length) && model.cost!.every((cost) => cost.input === 0)
export const isFreeGroupModel = (model: ModelInfo) => model.providerID === "opencode" && isFreeModel(model)

export const SEPARATOR = " · "

/** 右栏内容的默认宽度；实测宽度不可用时按标准右栏宽度排版。 */
export const DEFAULT_CONTENT_WIDTH = 36

/** 窄栏下至少保留的宽度，保证状态与标题还放得下。 */
export const MIN_CONTENT_WIDTH = 12

/** 头部标签列宽：标签补齐到这里，值列对齐。 */
export const HEADER_LABEL_WIDTH = 10

/** 头部一行：标签补齐到同一宽度，值列对齐。 */
export function headerLine(label: string, value: string) {
  return `${label}${" ".repeat(Math.max(1, HEADER_LABEL_WIDTH - displayWidth(label)))}${value}`
}

/** 显示宽度：CJK、全角与表情占两列。 */
export function charWidth(char: string) {
  const code = char.codePointAt(0) ?? 0
  if (code === 0x200d) return 0
  if (code >= 0x1100 && code <= 0x115f) return 2
  if (code >= 0x2e80 && code <= 0x303e) return 2
  if (code >= 0x3041 && code <= 0x33ff) return 2
  if (code >= 0x3400 && code <= 0x4dbf) return 2
  if (code >= 0x4e00 && code <= 0x9fff) return 2
  if (code >= 0xa000 && code <= 0xa4cf) return 2
  if (code >= 0xac00 && code <= 0xd7a3) return 2
  if (code >= 0xf900 && code <= 0xfaff) return 2
  if (code >= 0xfe30 && code <= 0xfe6f) return 2
  if (code >= 0xff00 && code <= 0xff60) return 2
  if (code >= 0xffe0 && code <= 0xffe6) return 2
  if (code >= 0x1f300 && code <= 0x1faff) return 2
  if (code >= 0x20000 && code <= 0x3fffd) return 2
  return 1
}

/** 文本在终端里占的列数。 */
export function displayWidth(text: string) {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/** 截断到给定列数，超出部分用省略号收尾。 */
export function truncate(text: string, width: number) {
  if (width <= 0) return ""
  if (displayWidth(text) <= width) return text
  let used = 0
  let out = ""
  for (const char of text) {
    const size = charWidth(char)
    if (used + size > width - 1) break
    out += char
    used += size
  }
  return `${out}…`
}

/** 会话是否正在执行。 */
export function isSessionRunning(context: Plugin.Context, sessionID: string) {
  const raw = context.data.session.status(sessionID)
  return raw === "running" || String(raw) === "busy"
}

/** 等待会话的执行真正停下来；超时返回 false。 */
export async function waitForSessionIdle(context: Plugin.Context, sessionID: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isSessionRunning(context, sessionID)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !isSessionRunning(context, sessionID)
}

/** 面向用户的错误说明。 */
export function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function withTimestampedFallback(session: SessionInfo) {
  return (
    session.title ??
    `${session.parentID ? "Child" : "New"} session - ${new Date(session.time?.created ?? Date.now()).toISOString()}`
  )
}

/** 会话标题：去掉 "@explore subagent" 这类内部标记，类型前缀不进面板。 */
export function subagentTitle(session: SessionInfo) {
  const title = withTimestampedFallback(session)
  const agentMatch = title.match(/@(\w+) subagent/)
  return agentMatch ? title.replace(agentMatch[0], "").trim() || title : title
}

/**
 * 一行的状态。活跃执行集合优先（与原生 Subagents 面板同源）：取消后重启仍在跑的
 * 会话即使残留 outcome，也必须显示运行中。运行中的子代理附带已运行时长。
 * 会话不在运行、但带有「后台任务仍在跑」标记时，显示 `⏳ 后台 N 个任务`。
 */
export function displayStatus(context: Plugin.Context, sessionID: string, options?: { now?: number; duration?: boolean }) {
  return sessionStatusView(context.data.session.get(sessionID), isSessionRunning(context, sessionID), {
    now: options?.now ?? Date.now(),
    duration: options?.duration ?? false,
  })
}

export function rootModelLabel(view: ModelView | undefined) {
  if (!view?.actual) return ""
  return view.display ?? modelKey(view.actual)
}

export function toSessionInput(context: Plugin.Context, session: SessionInfo): SessionInput {
  return {
    id: session.id,
    parentID: session.parentID,
    title: subagentTitle(session),
    agent: session.agent,
    status: context.data.session.status(session.id),
    model: session.model,
    updated: session.time?.updated ?? 0,
    created: session.time?.created ?? 0,
  }
}

export function decorate(
  node: AgentNode,
  settings: RootSettings,
  parentModel: ModelRef | undefined,
  names: Map<string, string>,
  isDelegated: (sessionID: string) => boolean = () => false,
) {
  const applyName = (model: ModelRef | undefined) => {
    if (!model) return
    const name = names.get(modelKey(model)) ?? names.get(`${model.providerID}/${model.id}`)
    if (!name) return
    if (!node.model) return
    node.model.display = name
  }

  if (node.kind === "root") {
    if (node.model?.actual) {
      const actual = node.model.actual
      node.model.display = names.get(modelKey(actual)) ?? names.get(`${actual.providerID}/${actual.id}`) ?? actual.id
    }
  }

  if (node.kind !== "root" && node.sessionID) {
    const explicit = settings.policies[node.sessionID]
    // 显式 input.model 委派只在展示层等价于手动 fixed；不反向写用户策略。
    const delegated = isDelegated(node.sessionID)
    const policy = delegated ? ("fixed" as const) : explicit ?? settings.defaultPolicy ?? "inherit"
    const newerThanDefault =
      !delegated &&
      node.created !== undefined && settings.defaultSetAt !== undefined && node.created > settings.defaultSetAt
    const fixedDefault =
      settings.defaultPolicy === "fixed" &&
      settings.defaultModel &&
      newerThanDefault &&
      !settings.keptSubagents?.[node.sessionID]
        ? settings.defaultModel
        : undefined
    const actual =
      explicit === "fixed"
        ? node.model?.actual ?? parentModel
        : explicit === "auto"
          ? node.model?.actual
          : policy === "inherit"
            ? parentModel
            : policy === "auto"
              ? node.model?.actual
              : fixedDefault ?? node.model?.actual ?? settings.defaultModel ?? parentModel
    node.model =
      policy === "auto"
        ? { policy: { kind: "auto" }, actual }
        : policy === "inherit"
          ? { policy: { kind: "inherit" }, actual: parentModel }
          : actual ?? parentModel
            ? { policy: { kind: "fixed", model: actual ?? parentModel! }, actual: actual ?? parentModel }
            : undefined
  }
  applyName(node.model?.actual)
  for (const child of node.children) decorate(child, settings, parentModel, names, isDelegated)
}
