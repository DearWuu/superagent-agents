/**
 * 面板行数据的纯展示计算：状态、缩进前缀、标题/模型/用量/徽标与颜色。
 *
 * 只读 context 与调用方注入的访问器，不写设置、不发请求；SidebarAgents 负责
 * 把结果交给 AgentPanelView。
 */

import type { Plugin } from "@opencode/plugin/tui"
import type { FlatNode } from "./agent-tree"
import { modelLabel } from "./agent-tree"
import { contextUsageView } from "./panel-context"
import {
  MIN_CONTENT_WIDTH,
  SEPARATOR,
  displayStatus,
  displayWidth,
  rootModelLabel,
  truncate,
} from "./panel-utils"
import type { RootSettings } from "./session-scope"
import type { OversightContract } from "./oversight"

export function createRowHelpers(deps: {
  context: Plugin.Context
  theme: Plugin.Context["theme"]
  root: () => RootSettings
  autoModels: () => Array<{ providerID: string; id: string; variant?: string }>
  now: () => number
  panelWidth: () => number
  oversightFor: (sessionID?: string) => OversightContract
  rootSessionID: () => string | undefined
  accentColor: () => string
  warningColor: () => string
}) {
  const {
    context,
    theme,
    root,
    autoModels,
    now,
    panelWidth,
    oversightFor,
    rootSessionID,
    accentColor,
    warningColor,
  } = deps

  const rowStatus = (row: FlatNode) =>
    row.node.sessionID
      ? displayStatus(context, row.node.sessionID, { now: now(), duration: row.node.kind !== "root" })
      : { glyph: "○", text: "等待中", longRunning: false }

  /** 标题行的前缀：层级缩进，加上折叠箭头（有子节点时）。 */
  const rowPrefix = (row: FlatNode) => "  ".repeat(row.depth) + (row.hasChildren ? (row.expanded ? "▼ " : "▶ ") : "")

  /** 标题文字的起始列：前缀之后留给状态图标与空格。 */
  const titleColumn = (row: FlatNode) => displayWidth(rowPrefix(row)) + 2

  /** 第一行：状态图标加标题；标题过长时单行省略号截断。 */
  const rowTitle = (row: FlatNode) => {
    const prefix = `${rowStatus(row).glyph} `
    const locked =
      row.node.kind === "subagent" && row.node.sessionID && root().keptSubagents?.[row.node.sessionID] ? " 🔒" : ""
    const room = Math.max(1, panelWidth() - titleColumn(row) - displayWidth(locked))
    return `${prefix}${truncate(row.node.title, room)}${locked}`
  }

  /** 一行的模型名：全名，不省略。 */
  const rowModel = (row: FlatNode) =>
    row.node.kind === "root"
      ? rootModelLabel(row.node.model)
      : modelLabel(row.node.model, autoModels().length > 0) || "设置模型…"

  /** 一行的徽标：跟随默认只写等级，用户固定过的写全。 */
  const rowBadge = (row: FlatNode) => {
    const contract = oversightFor(row.node.sessionID ?? rootSessionID())
    if (row.node.kind === "root") return `监管 L${contract.level} ${contract.name}`
    if (contract.source === "pin") return `监管 L${contract.level} ${contract.name}`
    return `L${contract.level}`
  }

  /** 子代理的上下文读数：最近一次 assistant 调用的输入规模，无数据时整段不显示。 */
  const rowUsage = (row: FlatNode) =>
    row.node.kind === "subagent" && row.node.sessionID
      ? contextUsageView(
          context.data.session.message.list(row.node.sessionID),
          row.node.model?.actual,
        )
      : undefined

  /**
   * 第二行：状态 · 模型全名 · token 用量 · 徽标。
   * 模型名永不省略：状态与模型放不下时模型自己换行，用量与徽标放不下时另起一行。
   * 状态段单独返回，便于长时运行时给它上警示色。
   */
  const rowInfo = (row: FlatNode) => {
    const indent = " ".repeat(titleColumn(row))
    const view = row.node.kind === "root" ? undefined : rowStatus(row)
    const status = view?.text ?? ""
    const model = rowModel(row)
    const badge = rowBadge(row)
    const usage = rowUsage(row)
    const usageText = usage ? `${usage.text}${usage.warning ? " ⚠" : ""}` : undefined
    const room = Math.max(MIN_CONTENT_WIDTH, panelWidth() - displayWidth(indent))
    const head = status ? `${status}${SEPARATOR}${model}` : model
    const oneLine = displayWidth(head) <= room
    const stacked = Boolean(status) && !oneLine
    const tail = [usageText, badge].filter(Boolean).join(SEPARATOR)
    const inline = oneLine && displayWidth(head) + displayWidth(`${SEPARATOR}${tail}`) <= room
    return {
      status: status ? `${indent}${status}` : undefined,
      statusWarning: view?.longRunning ?? false,
      model: status && !stacked ? `${SEPARATOR}${model}` : `${indent}${model}`,
      stacked,
      usage: usageText ? (inline ? `${SEPARATOR}${usageText}` : `${indent}${usageText}`) : undefined,
      usageWarning: usage?.warning ?? false,
      badge: inline || usageText ? `${SEPARATOR}${badge}` : `${indent}${badge}`,
      ownLine: !inline,
    }
  }

  /** 一行标题的颜色：长时间运行用告警色，运行中用强调色，结束态与等待中淡化。 */
  const titleColor = (row: FlatNode) => {
    const status = rowStatus(row)
    if (status.longRunning) return warningColor()
    if (status.glyph === "●") return accentColor()
    return theme.text.muted
  }

  /** 徽标的颜色：用户固定过的等级正常亮色，跟随默认的等级淡化。 */
  const badgeColor = (row: FlatNode) => {
    if (row.node.kind === "root") return theme.text.muted
    const contract = oversightFor(row.node.sessionID ?? rootSessionID())
    return contract.source === "pin" ? theme.text.base : theme.text.muted
  }

  return {
    rowStatus,
    rowPrefix,
    titleColumn,
    rowTitle,
    rowModel,
    rowBadge,
    rowUsage,
    rowInfo,
    titleColor,
    badgeColor,
  }
}
