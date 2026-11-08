/**
 * Flagship subagents use the same provider/model/variant as the Superagent.
 * These helpers keep the identity rules and the separate flagship cap in one
 * place so the TUI, the server and tests read the same definition.
 */

export const DEFAULT_MAX_FLAGSHIP_SUBAGENTS = 2
export const MIN_MAX_FLAGSHIP_SUBAGENTS = 0
export const MAX_MAX_FLAGSHIP_SUBAGENTS = 20
/** Session metadata marker written by the server and preserved across model changes. */
export const FLAGSHIP_METADATA_KEY = "superagent.flagship"

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
 * A model-bearing marker is stale once the child's current model differs.
 * Legacy `true` markers carry no model and remain valid; malformed markers and
 * explicit `false` never mean flagship.
 */
function markerMeansFlagship(value: unknown, current: unknown): boolean {
  if (value === false || value === undefined || value === null) return false
  if (value === true) return true
  if (typeof value === "string") {
    const text = value.trim().toLowerCase()
    if (["true", "1", "yes", "on"].includes(text)) return true
    if (["false", "0", "no", "off"].includes(text)) return false
  }
  const marked = isRecord(value) && value.model !== undefined ? value.model : value
  if (!normalizeFlagshipModel(marked)) return false
  // An unknown current model cannot disprove a valid persisted marker.
  if (!normalizeFlagshipModel(current)) return true
  return sameFlagshipModel(current, marked)
}

/**
 * The marker preserves creation identity when only the root changes model.
 * The root model is consulted only for sessions created before markers existed.
 */
export function isFlagshipSession(candidate: FlagshipSessionRef | undefined, root: unknown): boolean {
  if (!candidate) return false
  const marker = metadataMarker(candidate.metadata)
  if (marker !== undefined) return markerMeansFlagship(marker, candidate.model)
  return isFlagshipModel(candidate.model, root)
}

export function countFlagshipSubagents(candidates: readonly FlagshipSessionRef[], root: unknown): number {
  return candidates.filter((candidate) => isFlagshipSession(candidate, root)).length
}

/**
 * Admission for a model change. Staying on the same model, or moving away
 * from it, never increases the flagship count; only entering the flagship
 * set needs a free slot.
 */
export function flagshipChangeAllowed(input: {
  current: number
  limit: number
  alreadyFlagship: boolean
  targetFlagship: boolean
}): boolean {
  if (!input.targetFlagship || input.alreadyFlagship) return true
  return input.current + 1 <= input.limit
}