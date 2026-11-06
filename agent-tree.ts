import type { ModelRef, TaskModelPolicy } from "./model-policy"
import { modelKey } from "./model-policy"

export type TaskStatus = "pending" | "running" | "waiting" | "review" | "blocked" | "failed" | "done" | "stopped"

export type AgentNodeKind = "root" | "task" | "subagent"

export type ModelView = {
  policy: TaskModelPolicy
  /** The model used by the current/last Assignment. */
  actual?: ModelRef
  /** A model already chosen for the next Assignment, if any. */
  next?: ModelRef
  display?: string
}

export type AgentNode = {
  id: string
  kind: AgentNodeKind
  title: string
  status: TaskStatus | "idle"
  sessionID?: string
  taskID?: string
  taskNumber?: number
  agent?: string
  /** Session creation time, used to decide whether a new default applies. */
  created?: number
  model?: ModelView
  children: AgentNode[]
}

export type SessionInput = {
  id: string
  parentID?: string
  title: string
  agent?: string
  status: string
  model?: ModelRef
  /** Last activity time; newer sessions sort first among non-running siblings. */
  updated?: number
  /** Creation time; fixed defaults only apply to sessions created afterwards. */
  created?: number
}

export type TaskInput = {
  id: string
  number: number
  title: string
  status: TaskStatus
  parentSessionID: string
  workerSessionID?: string
  model: ModelView
  children?: SessionInput[]
}

export type BuildTreeInput = {
  root: SessionInput
  tasks: readonly TaskInput[]
  sessions: readonly SessionInput[]
  /** False when the global auto model list is empty. */
  autoConfigured: boolean
}

const statusRank: Record<TaskStatus, number> = {
  running: 0,
  waiting: 1,
  review: 2,
  pending: 3,
  blocked: 4,
  failed: 5,
  done: 6,
  stopped: 7,
}

const sessionStatus = (status: string): TaskStatus | "idle" => {
  if (status === "running" || status === "busy") return "running"
  if (status === "idle") return "idle"
  if (status === "completed") return "done"
  if (status === "error" || status === "failed") return "failed"
  return "idle"
}

const compareSessions = (a: SessionInput, b: SessionInput) => {
  const ar = sessionStatus(a.status) === "running" ? 0 : 1
  const br = sessionStatus(b.status) === "running" ? 0 : 1
  return ar - br || (b.updated ?? 0) - (a.updated ?? 0) || a.title.localeCompare(b.title)
}

const modelName = (model: ModelRef) => (model.variant ? `${model.id}#${model.variant}` : model.id)

export function modelLabel(view: ModelView | undefined, autoConfigured = true): string {
  if (!view) return ""
  const name = (model: ModelRef) => view.display ?? modelName(model)
  if (view.policy.kind === "auto") {
    if (!autoConfigured) return "auto off"
    return view.actual ? `auto→${name(view.actual)}` : "auto"
  }
  if (view.policy.kind === "inherit") {
    return view.actual ? `inherit→${name(view.actual)}` : "inherit"
  }
  return view.policy.model ? name(view.policy.model) : ""
}

function buildSession(
  session: SessionInput,
  byParent: Map<string, SessionInput[]>,
  taskByWorker: Map<string, TaskInput>,
  claimed: Set<string>,
  depth = 0,
): AgentNode {
  const claimedTask = taskByWorker.get(session.id)
  if (claimedTask && depth > 0) {
    return buildTask(claimedTask, byParent, taskByWorker, claimed)
  }
  const children = (byParent.get(session.id) ?? [])
    .filter((child) => !claimed.has(child.id))
    .sort(compareSessions)
    .map((child) => buildSession(child, byParent, taskByWorker, claimed, depth + 1))

  return {
    id: session.id,
    kind: depth === 0 ? "root" : "subagent",
    title: session.title,
    status: depth === 0 ? "idle" : sessionStatus(session.status),
    sessionID: session.id,
    agent: session.agent,
    created: session.created,
    model: session.model ? { policy: { kind: "fixed", model: session.model }, actual: session.model } : undefined,
    children,
  }
}

function buildTask(
  task: TaskInput,
  byParent: Map<string, SessionInput[]>,
  taskByWorker: Map<string, TaskInput>,
  claimed: Set<string>,
): AgentNode {
  const children = task.workerSessionID
    ? (byParent.get(task.workerSessionID) ?? [])
        .filter((child) => !claimed.has(child.id))
        .map((child) => buildSession(child, byParent, taskByWorker, claimed, 1))
    : (task.children ?? []).map((child) => buildSession(child, byParent, taskByWorker, claimed, 1))

  return {
    id: `task:${task.id}`,
    kind: "task",
    title: `#${task.number} ${task.title}`,
    status: task.status,
    sessionID: task.workerSessionID,
    taskID: task.id,
    taskNumber: task.number,
    model: task.model,
    children,
  }
}

/**
 * Builds the always-visible agent tree. Superagent tasks and ordinary child
 * sessions share one tree; a worker Session is shown once, as its Task.
 */
export function buildAgentTree(input: BuildTreeInput): AgentNode {
  const byParent = new Map<string, SessionInput[]>()
  for (const session of input.sessions) {
    if (!session.parentID) continue
    const list = byParent.get(session.parentID) ?? []
    list.push(session)
    byParent.set(session.parentID, list)
  }

  const tasks = input.tasks
    .filter((task) => task.parentSessionID === input.root.id)
    .slice()
    .sort((a, b) => statusRank[a.status] - statusRank[b.status] || a.number - b.number)
  const taskByWorker = new Map(
    input.tasks.filter((task) => task.workerSessionID).map((task) => [task.workerSessionID!, task]),
  )
  const claimed = new Set(input.tasks.flatMap((task) => (task.workerSessionID ? [task.workerSessionID] : [])))

  const generic = (byParent.get(input.root.id) ?? [])
    .filter((session) => !claimed.has(session.id))
    .sort(compareSessions)
    .map((session) => buildSession(session, byParent, taskByWorker, claimed, 1))

  return {
    id: input.root.id,
    kind: "root",
    title: input.root.title,
    status: sessionStatus(input.root.status),
    sessionID: input.root.id,
    agent: input.root.agent,
    created: input.root.created,
    model: input.root.model
      ? { policy: { kind: "fixed", model: input.root.model }, actual: input.root.model }
      : undefined,
    children: [...tasks.map((task) => buildTask(task, byParent, taskByWorker, claimed)), ...generic],
  }
}

export type FlatNode = {
  node: AgentNode
  depth: number
  hasChildren: boolean
  expanded: boolean
  hiddenChildren: number
}

export type FlattenOptions = {
  /** Explicitly expanded nodes. Wins unless the node is also in `collapsed`. */
  expanded?: ReadonlySet<string>
  /** Explicitly collapsed nodes. Wins over both `expanded` and the status default. */
  collapsed?: ReadonlySet<string>
  /** Collapse finished tasks and idle subagents behind a summary row. */
  collapseCompleted?: boolean
}

/**
 * Produces the rows a sidebar renders. Roots and active nodes open by default;
 * finished nodes stay collapsed so the panel remains useful with many
 * historical subagents. Explicit expanded/collapsed choices always win.
 */
export function flattenAgentTree(root: AgentNode, options: FlattenOptions = {}): FlatNode[] {
  const expanded = options.expanded ?? new Set<string>()
  const collapsed = options.collapsed ?? new Set<string>()
  const collapseCompleted = options.collapseCompleted ?? true
  const rows: FlatNode[] = []

  const visit = (node: AgentNode, depth: number) => {
    const hasChildren = node.children.length > 0
    const isFinished = node.status === "done" || node.status === "stopped"
    const defaultOpen =
      node.kind === "root" ||
      node.status === "running" ||
      node.status === "pending" ||
      node.status === "waiting" ||
      node.status === "blocked" ||
      node.status === "failed"
    const open = collapsed.has(node.id)
      ? false
      : expanded.has(node.id)
        ? true
        : node.kind === "root"
          ? true
          : defaultOpen && !(collapseCompleted && isFinished)
    const visible = open ? node.children.length : 0
    rows.push({ node, depth, hasChildren, expanded: open, hiddenChildren: node.children.length - visible })
    if (open) for (const child of node.children) visit(child, depth + 1)
  }

  visit(root, 0)
  return rows
}

export function modelDisplay(view: ModelView | undefined) {
  if (!view) return ""
  if (view.policy.kind === "fixed") return modelKey(view.policy.model)
  if (view.actual) return modelKey(view.actual)
  return ""
}
