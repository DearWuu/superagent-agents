/**
 * The Subagent count limit and its automatic eviction.
 *
 * `maxSubagents` limits how many Subagents may exist under one family root
 * at the same time. When the tree holds more, the oldest finished Subagents
 * are removed automatically; running, protected and currently viewed sessions
 * are never touched.
 */

export type SubagentOutcome = "succeeded" | "failed" | "interrupted"

export type SubagentChild = {
  id: string
  title: string
  /** The runtime status of the child session. */
  status: string
  outcome?: SubagentOutcome
  /** Creation time; the oldest Subagent is evicted first. */
  created?: number
  /** Last activity time; used as a tie breaker. */
  updated?: number
}

export type EvictionInput = {
  /** The direct, non-archived children of the family root. */
  children: readonly SubagentChild[]
  /** The configured existence limit. */
  limit: number
  /** The session the user is looking at right now. */
  currentSessionID?: string
  /** Children the user protected. */
  keptSubagents?: Record<string, boolean>
}

export type EvictionPlan = {
  /** The sessions to remove, oldest first. */
  victims: SubagentChild[]
  /** The number of children that exceeds the limit. */
  excess: number
  /** True when the tree is over the limit but nothing can be removed safely. */
  blocked: boolean
}

const ACTIVE = new Set(["running", "busy"])

/** A running or busy child is never evicted. */
export function isActive(child: SubagentChild) {
  return ACTIVE.has(child.status)
}

/**
 * A finished child is one that already ended (succeeded, failed or
 * interrupted) or that never started and therefore sits idle.
 */
export function isFinished(child: SubagentChild) {
  if (isActive(child)) return false
  if (child.outcome === "succeeded" || child.outcome === "failed" || child.outcome === "interrupted") return true
  return child.status === "idle"
}

/**
 * Decides which Subagents have to go so the tree fits into the limit.
 * Running, protected and currently viewed sessions stay.
 */
export function planEviction(input: EvictionInput): EvictionPlan {
  const excess = input.children.length - input.limit
  if (excess <= 0) return { victims: [], excess: 0, blocked: false }
  const kept = input.keptSubagents ?? {}
  const victims = input.children
    .filter((child) => isFinished(child))
    .filter((child) => child.id !== input.currentSessionID)
    .filter((child) => !kept[child.id])
    .sort(
      (a, b) => (a.created ?? a.updated ?? 0) - (b.created ?? b.updated ?? 0) || (a.updated ?? 0) - (b.updated ?? 0),
    )
    .slice(0, excess)
  return { victims, excess, blocked: victims.length === 0 }
}
