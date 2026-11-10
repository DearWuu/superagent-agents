/**
 * Explicit model delegation marker.
 *
 * The native `subagent` tool applies `input.model` when it creates or steers a
 * child. The marker records that explicit choice so default-model
 * synchronization leaves the child alone while it stays on that model. It is
 * independent of the flagship marker: the delegated model may be any
 * provider/model/variant, and only the identity rules in `flagship.ts` decide
 * whether the same call also counts as a flagship.
 */

import type { ModelRef } from "./model-policy"

/** Session metadata marker written after a successful explicit-model call. */
export const MODEL_DELEGATION_METADATA_KEY = "superagent.model-delegation"
/**
 * Only markers written for an explicit `input.model` delegation carry this
 * source. Other shapes never protect a child from default-model synchronization.
 */
export const MODEL_DELEGATION_MARKER_SOURCE = "explicit-subagent-model"

export type ModelDelegationMarker = {
  model: ModelRef
  at: number
  source: typeof MODEL_DELEGATION_MARKER_SOURCE
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Accepts `provider/model#variant` or `{ providerID, id | modelID, variant? }`. */
export function normalizeModelDelegationModel(value: unknown): ModelRef | undefined {
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
export function sameModelDelegationModel(a: unknown, b: unknown): boolean {
  const left = normalizeModelDelegationModel(a)
  const right = normalizeModelDelegationModel(b)
  if (!left || !right) return false
  // An omitted variant and a provider-materialized "default" are equivalent.
  const variant = (model: ModelRef) => model.variant === "default" ? "" : (model.variant ?? "")
  return left.providerID === right.providerID && left.id === right.id && variant(left) === variant(right)
}

/**
 * Writes the delegation marker while keeping every other metadata key. Returns
 * undefined when the model reference is invalid.
 */
export function withModelDelegationMarker(
  metadata: unknown,
  model: unknown,
  at: number,
): Record<string, unknown> | undefined {
  const ref = normalizeModelDelegationModel(model)
  if (!ref) return undefined
  const base = isRecord(metadata) ? metadata : {}
  const marker: ModelDelegationMarker = { model: ref, at, source: MODEL_DELEGATION_MARKER_SOURCE }
  return { ...base, [MODEL_DELEGATION_METADATA_KEY]: marker }
}

/**
 * True only for a marker carrying the explicit-delegation source whose model
 * still equals the child's current model. Missing, legacy, malformed or stale
 * markers do not protect the child.
 */
export function isExplicitModelDelegation(
  candidate: { model?: unknown; metadata?: Record<string, unknown> } | undefined,
): boolean {
  if (!candidate) return false
  const marker = candidate.metadata?.[MODEL_DELEGATION_METADATA_KEY]
  if (!isRecord(marker)) return false
  if (marker.source !== MODEL_DELEGATION_MARKER_SOURCE) return false
  if (!normalizeModelDelegationModel(marker.model)) return false
  if (!normalizeModelDelegationModel(candidate.model)) return false
  return sameModelDelegationModel(marker.model, candidate.model)
}