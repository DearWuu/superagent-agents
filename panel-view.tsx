/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { For, Show } from "solid-js"
import type { AgentNode, FlatNode } from "./agent-tree"
import { criticView, type CriticRecord } from "./panel-critic"

type RowInfo = {
  stacked: boolean
  status?: string
  statusWarning?: boolean
  model: string
  ownLine: boolean
  usage?: string
  usageWarning?: boolean
  badge: string
  failure?: { status: string; error: string; warning: boolean }
}

/**
 * Sidebar 面板的渲染壳。只接收访问器与回调，不持有状态；状态与副作用都留在
 * SidebarAgents，保证拆分前后事件顺序与 DOM id 不变。
 */
export function AgentPanelView(props: {
  collabOn: () => boolean
  setCollabEnabled: (enabled: boolean) => unknown
  theme: Plugin.Context["theme"]
  tree: () => AgentNode | undefined
  openSettings: () => unknown
  openDefaults: () => unknown
  setMeasuredWidth: (width: number) => void
  headerText: (value: string) => string
  defaultLabel: () => string
  subagentOverLimit: () => boolean
  openOversightAudit: () => unknown
  subagentCountText: () => string
  openOversight: () => unknown
  oversightText: () => string
  rows: () => FlatNode[]
  setExpanded: (id: string, expanded: boolean) => void
  rowPrefix: (row: FlatNode) => string
  titleColor: (row: FlatNode) => string
  rowTitle: (row: FlatNode) => string
  openActions: (node: AgentNode) => unknown
  rowInfo: (row: FlatNode) => RowInfo
  warningColor: () => string
  openModel: (node: AgentNode) => unknown
  badgeColor: (row: FlatNode) => string
  openSubagentOversight: (node: AgentNode) => unknown
  criticRecord: (sessionID: string | undefined) => CriticRecord | undefined
  criticColor: (record: CriticRecord) => string
  openCritic: (node: AgentNode, record: CriticRecord) => unknown
  criticIndent: (row: FlatNode) => string
}) {
  const theme = props.theme
  return (
    <Show
      when={props.collabOn()}
      fallback={
        <box id="sidebar.agents" flexDirection="column">
          <text
            id="sidebar.agents.disabled"
            fg={theme.text.muted}
            onMouseUp={(event) => {
              if (event.button !== 0) return
              void props.setCollabEnabled(true)
            }}
          >
            agents协作已停用 · 本会话 · 左键开启
          </text>
        </box>
      }
    >
      <Show when={props.tree()}>
      {(value) => (
        <box
          id="sidebar.agents"
          flexDirection="column"
          onSizeChange={function () {
            props.setMeasuredWidth(this.width)
          }}
        >
          <box flexDirection="column" gap={0}>
            <text
              id="sidebar.agents.settings"
              fg={theme.text.base}
              onMouseUp={(event) => {
                if (event.button !== 0) return
                void props.openSettings()
              }}
            >
              <b>agents协作</b>
            </text>
            <text
              id="sidebar.agents.default"
              fg={theme.text.muted}
              onMouseUp={(event) => {
                if (event.button !== 0) return
                void props.openDefaults()
              }}
            >
              {props.headerText(props.defaultLabel())}
            </text>
            <text
              id="sidebar.agents.count"
              fg={props.subagentOverLimit() ? (theme.text.feedback?.warning?.base ?? theme.text.muted) : theme.text.muted}
              onMouseUp={(event) => {
                if (event.button !== 0) return
                void props.openOversightAudit()
              }}
            >
              {props.headerText(props.subagentCountText())}
            </text>
            <text
              id="sidebar.agents.oversight"
              fg={theme.text.muted}
              onMouseUp={(event) => {
                if (event.button !== 0) return
                void props.openOversight()
              }}
            >
              {props.headerText(props.oversightText())}
            </text>
          </box>
          <For each={props.rows()}>
            {(row) => (
              <box id={`sidebar.agents.row.${row.node.id}`} flexDirection="column">
                <box flexDirection="row" gap={0}>
                  <text
                    id={`sidebar.agents.toggle.${row.node.id}`}
                    fg={theme.text.base}
                    onMouseUp={(event) => {
                      if (event.button !== 0) return
                      if (row.hasChildren) props.setExpanded(row.node.id, !row.expanded)
                    }}
                  >
                    {props.rowPrefix(row)}
                  </text>
                  <text
                    id={`sidebar.agents.title.${row.node.id}`}
                    fg={props.titleColor(row)}
                    onMouseUp={(event) => {
                      if (event.button !== 0) return
                      if (row.node.kind === "subagent") void props.openActions(row.node)
                    }}
                  >
                    {props.rowTitle(row)}
                  </text>
                </box>
                <Show when={row.node.kind === "subagent" || row.node.model}>
                  <box flexDirection="row" gap={0}>
                    <box flexDirection={props.rowInfo(row).stacked ? "column" : "row"} gap={0}>
                      <Show when={props.rowInfo(row).status}>
                        {(status) => (
                          <text
                            id={`sidebar.agents.status.${row.node.id}`}
                            fg={props.rowInfo(row).statusWarning ? props.warningColor() : theme.text.muted}
                            flexShrink={0}
                          >
                            {status()}
                          </text>
                        )}
                      </Show>
                      <text
                        id={`sidebar.agents.model.${row.node.id}`}
                        fg={theme.text.muted}
                        wrapMode="word"
                        flexShrink={1}
                        onMouseUp={(event) => {
                          if (event.button !== 0) return
                          if (row.node.kind === "root") return
                          event.stopPropagation()
                          void props.openModel(row.node)
                        }}
                      >
                        {props.rowInfo(row).model}
                      </text>
                    </box>
                    <Show when={!props.rowInfo(row).ownLine}>
                      <Show when={props.rowInfo(row).usage}>
                        {(usage) => (
                          <text
                            id={`sidebar.agents.usage.${row.node.id}`}
                            fg={props.rowInfo(row).usageWarning ? props.warningColor() : theme.text.muted}
                            flexShrink={0}
                          >
                            {usage()}
                          </text>
                        )}
                      </Show>
                      <text
                        id={`sidebar.agents.badge.${row.node.id}`}
                        fg={props.badgeColor(row)}
                        flexShrink={0}
                        onMouseUp={(event) => {
                          if (event.button !== 0) return
                          if (row.node.kind !== "subagent") return
                          event.stopPropagation()
                          void props.openSubagentOversight(row.node)
                        }}
                      >
                        {props.rowInfo(row).badge}
                      </text>
                    </Show>
                  </box>
                  <Show when={props.rowInfo(row).ownLine}>
                    <box flexDirection="row" gap={0}>
                      <Show when={props.rowInfo(row).usage}>
                        {(usage) => (
                          <text
                            id={`sidebar.agents.usage.${row.node.id}`}
                            fg={props.rowInfo(row).usageWarning ? props.warningColor() : theme.text.muted}
                            flexShrink={0}
                          >
                            {usage()}
                          </text>
                        )}
                      </Show>
                      <text
                        id={`sidebar.agents.badge.${row.node.id}`}
                        fg={props.badgeColor(row)}
                        flexShrink={0}
                        onMouseUp={(event) => {
                          if (event.button !== 0) return
                          if (row.node.kind !== "subagent") return
                          event.stopPropagation()
                          void props.openSubagentOversight(row.node)
                        }}
                      >
                        {props.rowInfo(row).badge}
                      </text>
                    </box>
                  </Show>
                </Show>
                <Show when={props.rowInfo(row).failure}>
                  {(failure) => (
                    <box flexDirection="column">
                      <text
                        id={`sidebar.agents.retry.${row.node.id}`}
                        fg={failure().warning ? props.warningColor() : theme.text.muted}
                        wrapMode="none"
                      >
                        {failure().status}
                      </text>
                      <text
                        id={`sidebar.agents.failure.${row.node.id}`}
                        fg={failure().warning ? props.warningColor() : theme.text.muted}
                        wrapMode="word"
                      >
                        {failure().error}
                      </text>
                    </box>
                  )}
                </Show>
                <Show when={row.node.kind === "subagent" ? props.criticRecord(row.node.sessionID) : undefined}>
                  {(record) => (
                    <box flexDirection="row" gap={0}>
                      <text
                        id={`sidebar.agents.critic.${row.node.id}`}
                        fg={props.criticColor(record())}
                        onMouseUp={(event) => {
                          if (event.button !== 0) return
                          event.stopPropagation()
                          void props.openCritic(row.node, record())
                        }}
                      >
                        {`${props.criticIndent(row)}${criticView(record().verdict).text}`}
                      </text>
                    </box>
                  )}
                </Show>
              </box>
            )}
          </For>
          <Show when={value().children.length === 0}>
            <text fg={theme.text.muted}>暂无子代理，分配任务后显示</text>
          </Show>
        </box>
      )}
      </Show>
    </Show>
  )
}
