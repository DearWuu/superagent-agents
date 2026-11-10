/**
 * 子代理自动淘汰：总上限与旗舰上限两条线，按 planEviction 的结果删除最旧的
 * 已完成子会话。删除进度与防重入标记都是本工厂的局部状态。
 *
 * 反应式触发留在 SidebarAgents 的 effect 里；这里只暴露一次淘汰入口。
 */

import type { Plugin } from "@opencode/plugin/tui"
import type { AgentNode } from "./agent-tree"
import { isFlagshipSession } from "./flagship"
import { appendOversightEvent } from "./panel-critic"
import { subagentTitle } from "./panel-utils"
import type { RootSettings } from "./session-scope"
import type { SessionInfo } from "./panel-types"
import { planEviction, type SubagentChild } from "./subagent-limit"

export function createEvictionActions(deps: {
  context: Plugin.Context
  sessionID: string
  rootSessionID: () => string | undefined
  root: () => RootSettings
  subagentLimit: () => number
  directSubagents: () => SessionInfo[]
  tree: () => AgentNode | undefined
  flagshipLimit: () => number
}) {
  const { context, sessionID, rootSessionID, root, subagentLimit, directSubagents, tree, flagshipLimit } = deps

  /** Sessions whose removal is already running; they are never deleted twice. */
  const evicting = new Set<string>()
  let pruning = false
  let pruneAgain = false

  /**
   * Keeps the number of Subagents under the limit. The oldest finished
   * Subagent goes first; running, protected, pending and currently viewed
   * sessions stay.
   */
  function evictionChild(item: SessionInfo): SubagentChild {
    return {
      id: item.id,
      title: subagentTitle(item),
      status: String(context.data.session.status(item.id)),
      outcome: item.outcome as SubagentChild["outcome"],
      created: item.time?.created,
      updated: item.time?.updated,
    }
  }
  async function removeEvictionVictims(
    victims: SubagentChild[],
    reason: { limit: number; label: string },
  ) {
    for (const victim of victims) {
      evicting.add(victim.id)
      try {
        await context.client.session.remove({ sessionID: victim.id })
        context.ui.toast.show({
          message: `已自动淘汰子代理「${victim.title}」(${victim.id})：${reason.label} ${reason.limit}，已删除最旧的已完成子代理。`,
        })
        void appendOversightEvent("subagent.evicted", {
          rootSessionID: rootSessionID(),
          sessionID: victim.id,
          title: victim.title,
          limit: reason.limit,
          reason: reason.label,
        }).catch(() => {})
      } catch {
        // The session stays; a later prune tries again.
      } finally {
        evicting.delete(victim.id)
      }
    }
  }
  async function evictExcessSubagents() {
    if (pruning) {
      pruneAgain = true
      return
    }
    pruning = true
    try {
      do {
        pruneAgain = false
        const limit = subagentLimit()
        const children = directSubagents()
        const plan = planEviction({
          children: children.map(evictionChild),
          limit,
          currentSessionID: sessionID,
          keptSubagents: root().keptSubagents,
        })
        const victims = plan.victims.filter((victim) => !evicting.has(victim.id))
        if (victims.length === 0) break
        await removeEvictionVictims(victims, { limit, label: "超出上限" })
      } while (pruneAgain)

      // The flagship cap is a second, narrower limit over explicit-delegation
      // markers only. The oldest finished flagships are candidates; total-cap
      // eviction has already run first.
      const limit = flagshipLimit()
      const effectiveModels = new Map(
        (tree()?.children ?? []).flatMap((node) => (node.sessionID ? [[node.sessionID, node.model?.actual] as const] : [])),
      )
      const flagships = directSubagents().filter((item) =>
        isFlagshipSession({ model: effectiveModels.get(item.id) ?? item.model, metadata: item.metadata }),
      )
      const plan = planEviction({
        children: flagships.map(evictionChild),
        limit,
        currentSessionID: sessionID,
        keptSubagents: root().keptSubagents,
      })
      const victims = plan.victims.filter((victim) => !evicting.has(victim.id))
      if (victims.length > 0) await removeEvictionVictims(victims, { limit, label: "超出旗舰上限" })
    } finally {
      pruning = false
    }
  }

  return { evictExcessSubagents }
}
