/**
 * Flagship subagents are the Superagent's explicit same-provider/model/variant
 * delegations. Identity lives only in the metadata marker written when such a
 * call succeeds; a session whose model merely equals the root model stays an
 * ordinary Subagent. These helpers keep the identity rules and the separate
 * flagship cap in one place so the TUI, the server and tests read the same
 * definition.
 */

export const DEFAULT_MAX_FLAGSHIP_SUBAGENTS = 2
export const MIN_MAX_FLAGSHIP_SUBAGENTS = 0
export const MAX_MAX_FLAGSHIP_SUBAGENTS = 20
/** Session metadata marker written by the server and preserved across model changes. */
export const FLAGSHIP_METADATA_KEY = "superagent.flagship"
/**
 * Provenance of a flagship marker: only markers written for an explicit
 * same-model subagent delegation carry this source. Markers without it
 * (including markers from earlier automatic model-equality writes) never
 * mean flagship.
 */
export const FLAGSHIP_MARKER_SOURCE = "explicit-subagent-delegation"

export type ModelRef = {
  providerID: string
  id: string
  variant?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Accepts `provider/model#variant` or `{ providerID, id | modelID, variant? }`. */
export function normalizeFlagshipModel(value: unknown): ModelRef | undefined {
  if (typeof value === "string") {
    const text = value.trim()
    const hash = text.lastIndexOf("#")
    const variant = hash >= 0 ? text.slice(hash + 1) : undefined
    const body = hash >= 0 ? text.slice(0, hash) : text
    const slash = body.indexOf("/")
    if (slash <= 0 || slash >= body.length - 1) return undefined
    const providerID = body.slice(0, slash)
    const id = body.slice(slash + 1)
    if (!providerID || !id || variant === "") return undefined
    return variant ? { providerID, id, variant } : { providerID, id }
  }
  if (!isRecord(value)) return undefined
  const providerID = typeof value.providerID === "string" ? value.providerID.trim() : ""
  const id = typeof value.id === "string" ? value.id.trim() : typeof value.modelID === "string" ? value.modelID.trim() : ""
  if (!providerID || !id) return undefined
  const variant = typeof value.variant === "string" && value.variant ? value.variant : undefined
  return variant ? { providerID, id, variant } : { providerID, id }
}

/** Same provider and model id, with the same variant (absence equals absence). */
export function sameFlagshipModel(a: unknown, b: unknown): boolean {
  const left = normalizeFlagshipModel(a)
  const right = normalizeFlagshipModel(b)
  if (!left || !right) return false
  // An omitted variant and a provider-materialized "default" are equivalent.
  const variant = (model: ModelRef) => model.variant === "default" ? "" : (model.variant ?? "")
  return left.providerID === right.providerID && left.id === right.id && variant(left) === variant(right)
}

/** Unknown or malformed model references are never counted as definite flagships. */
export function isFlagshipModel(candidate: unknown, root: unknown): boolean {
  return sameFlagshipModel(candidate, root)
}

export function normalizeMaxFlagshipSubagents(value: unknown, fallback = DEFAULT_MAX_FLAGSHIP_SUBAGENTS): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  if (parsed < MIN_MAX_FLAGSHIP_SUBAGENTS) return MIN_MAX_FLAGSHIP_SUBAGENTS
  if (parsed > MAX_MAX_FLAGSHIP_SUBAGENTS) return MAX_MAX_FLAGSHIP_SUBAGENTS
  return parsed
}

/** The flagship cap can never exceed the existing total Subagent cap. */
export function effectiveFlagshipLimit(configured: unknown, totalLimit: number): number {
  const total = Number.isFinite(totalLimit) ? Math.max(0, Math.floor(totalLimit)) : 0
  return Math.min(normalizeMaxFlagshipSubagents(configured), total)
}

export type FlagshipSessionRef = {
  model?: unknown
  metadata?: Record<string, unknown>
}

function metadataMarker(metadata: Record<string, unknown> | undefined): unknown {
  return metadata ? metadata[FLAGSHIP_METADATA_KEY] : undefined
}

/**
 * Only an explicit-delegation marker counts: a record carrying
 * `source: "explicit-subagent-delegation"` with a valid model. Every other
 * shape — explicit `false`, legacy `true`, bare model references, or a
 * `{ model, at }` record without the source — means an ordinary Subagent.
 * A valid marker goes stale once the child's current model differs.
 */
function markerMeansFlagship(value: unknown, current: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.source !== FLAGSHIP_MARKER_SOURCE) return false
  const marked = value.model
  if (!normalizeFlagshipModel(marked)) return false
  // An unknown current model cannot disprove a valid persisted marker.
  if (!normalizeFlagshipModel(current)) return true
  return sameFlagshipModel(current, marked)
}

/**
 * Flagship identity comes only from an explicit-delegation marker on the
 * child's own metadata (`source: "explicit-subagent-delegation"` with a
 * matching model). Unmarked sessions — and sessions whose model merely equals
 * the root model — are ordinary Subagents; the `root` argument is kept for
 * signature compatibility and ignored.
 */
export function isFlagshipSession(candidate: FlagshipSessionRef | undefined, _root?: unknown): boolean {
  if (!candidate) return false
  return markerMeansFlagship(metadataMarker(candidate.metadata), candidate.model)
}

export function countFlagshipSubagents(candidates: readonly FlagshipSessionRef[], _root?: unknown): number {
  return candidates.filter((candidate) => isFlagshipSession(candidate)).length
}
