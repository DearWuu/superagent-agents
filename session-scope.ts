/**
 * Scoped task-orchestrator state.
 *
 * Everything that belongs to one conversation tree lives under
 * `roots[rootSessionID]`. Only the global model list is shared between roots.
 * The document is versioned: v1 held one flat set of settings for the whole
 * app, which leaked one root's policy into the next.
 */

export type Policy = "auto" | "inherit" | "fixed"

export type ModelRef = { providerID: string; id: string; variant?: string }

export type OversightPins = {
  global?: number
  models?: Record<string, number>
  sessions?: Record<string, number>
}

/** Settings that belong to a single family root session. */
export type RootSettings = {
  /** Per-child model policy inside this root. */
  policies: Record<string, Policy>
  defaultPolicy: Policy
  defaultModel?: ModelRef
  /** When the fixed default was chosen; only newer child sessions inherit it. */
  defaultSetAt?: number
  /** The maximum number of Subagents that may exist under this root at once. */
  maxSubagents: number
  /** Tree expansion state of this root. */
  expanded: Record<string, boolean>
  /** Sessions whose instruction defaults were already written. */
  initialized: Record<string, boolean>
  /** Subagents the user protected from automatic eviction. */
  keptSubagents: Record<string, boolean>
  /** The user's own assignment prompt, without the report protocol prefix. */
  assignmentPrompt: string
  oversight: {
    pins: OversightPins
    capabilityOverrides: Record<string, number>
    history: Record<string, { n: number; success: number; severe: number; lastAt: number }>
    lastResolved: Record<string, { level: number; source: string; at: number }>
  }
}

/** The persisted document. */
export type ScopedSettings = {
  version: number
  /** Global: the models automatic assignment may pick from. */
  autoModels: ModelRef[]
  /** Scoped by family root session id. */
  roots: Record<string, RootSettings>
}

export const SETTINGS_VERSION = 2

export const DEFAULT_MAX_SUBAGENTS = 5
export const MIN_MAX_SUBAGENTS = 1
export const MAX_MAX_SUBAGENTS = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record<T>(value: unknown): Record<string, T> {
  return isRecord(value) ? (value as Record<string, T>) : {}
}

/** Clamps a user-provided Subagent cap into the supported range. */
export function normalizeMaxSubagents(value: unknown, fallback = DEFAULT_MAX_SUBAGENTS) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  if (parsed < MIN_MAX_SUBAGENTS) return MIN_MAX_SUBAGENTS
  if (parsed > MAX_MAX_SUBAGENTS) return MAX_MAX_SUBAGENTS
  return parsed
}

export function defaultRootSettings(): RootSettings {
  return {
    policies: {},
    defaultPolicy: "inherit",
    defaultModel: undefined,
    defaultSetAt: undefined,
    maxSubagents: DEFAULT_MAX_SUBAGENTS,
    expanded: {},
    initialized: {},
    keptSubagents: {},
    assignmentPrompt: "",
    oversight: {
      pins: { models: {}, sessions: {} },
      capabilityOverrides: {},
      history: {},
      lastResolved: {},
    },
  }
}

/**
 * Reads one root's settings. The result is rebuilt from the known fields, so
 * a stored `pendingModels` map (model switches waiting for the next turn) is
 * ignored here and dropped from the document on the next write.
 */
export function normalizeRootSettings(value: unknown): RootSettings {
  const source = isRecord(value) ? value : {}
  const defaultPolicy: Policy =
    source.defaultPolicy === "auto" || source.defaultPolicy === "inherit" || source.defaultPolicy === "fixed"
      ? source.defaultPolicy
      : "inherit"
  const oversight = isRecord(source.oversight) ? source.oversight : {}
  const pins = isRecord(oversight.pins) ? oversight.pins : {}
  return {
    policies: record<Policy>(source.policies),
    defaultPolicy,
    defaultModel: isRecord(source.defaultModel) ? (source.defaultModel as ModelRef) : undefined,
    defaultSetAt: typeof source.defaultSetAt === "number" ? source.defaultSetAt : undefined,
    maxSubagents: normalizeMaxSubagents(source.maxSubagents),
    expanded: record<boolean>(source.expanded),
    initialized: record<boolean>(source.initialized),
    keptSubagents: record<boolean>(source.keptSubagents),
    assignmentPrompt: typeof source.assignmentPrompt === "string" ? source.assignmentPrompt : "",
    oversight: {
      pins: {
        global: typeof pins.global === "number" ? pins.global : undefined,
        models: record<number>(pins.models),
        sessions: record<number>(pins.sessions),
      },
      capabilityOverrides: record<number>(oversight.capabilityOverrides),
      history: record(oversight.history),
      lastResolved: record(oversight.lastResolved),
    },
  }
}

/** True when the stored document predates the scoped layout. */
export function isLegacySettings(value: unknown): boolean {
  if (!isRecord(value)) return false
  return !isRecord(value.roots)
}

/**
 * Moves a legacy flat document into the root that is open right now. The
 * migrated values belong to that root only; every other root starts clean.
 */
export function migrateLegacySettings(value: unknown, rootID: string): ScopedSettings {
  const source = isRecord(value) ? value : {}
  const root = normalizeRootSettings({
    policies: source.policies,
    defaultPolicy: source.defaultPolicy,
    defaultModel: source.defaultModel,
    defaultSetAt: source.defaultSetAt,
    maxSubagents: source.maxSubagents,
    expanded: source.expanded,
    initialized: source.initialized,
    assignmentPrompt: source.assignmentPrompt,
    oversight: source.oversight,
  })
  return {
    version: SETTINGS_VERSION,
    autoModels: Array.isArray(source.autoModels) ? (source.autoModels as ModelRef[]) : [],
    roots: { [rootID]: root },
  }
}

/** The scoped settings of one root, with defaults for anything missing. */
export function readRootSettings(value: unknown, rootID: string): RootSettings {
  if (isLegacySettings(value)) return migrateLegacySettings(value, rootID).roots[rootID]
  const source = value as ScopedSettings
  return normalizeRootSettings(source.roots?.[rootID])
}

/**
 * Returns the scoped settings of one root inside a mutable draft and makes
 * sure the draft uses the scoped layout. A legacy draft is migrated into
 * `legacyOwner` on the way, so a write never spreads one root's settings
 * into another.
 */
export function scopedRootDraft(draft: Record<string, any>, rootID: string, legacyOwner?: string): RootSettings {
  if (isLegacySettings(draft)) {
    const migrated = migrateLegacySettings(draft, legacyOwner ?? rootID)
    for (const key of Object.keys(draft)) delete draft[key]
    Object.assign(draft, migrated)
  }
  draft.version = SETTINGS_VERSION
  if (!isRecord(draft.roots)) draft.roots = {}
  draft.roots[rootID] = normalizeRootSettings(draft.roots[rootID])
  return draft.roots[rootID] as RootSettings
}

/**
 * The counter of the right column: how many Subagents exist against the
 * limit, and how many of them are running right now.
 */
export function formatSubagentCounter(input: { existing: number; limit: number; running: number }) {
  const over = input.existing > input.limit
  return `${over ? "!" : ""}${input.existing}/${input.limit} · 运行中 ${input.running}`
}
