/**
 * Server-side admission for explicit same-model flagship Subagents.
 *
 * `superagent.max-flagship-subagents` is a separate cap on top of the total
 * Subagent cap. Only a call whose `input.model` explicitly names the root's
 * provider/model/variant is flagship admission; inherited, agent-default,
 * UI and fallback-model paths never enter this cap. Identity persists only
 * through the marker written after a successful call, reused via the shared
 * marker-only `isFlagshipSession` so the hook wiring, panel and tests share
 * one definition.
 */

import {
  DEFAULT_MAX_FLAGSHIP_SUBAGENTS,
  FLAGSHIP_MARKER_SOURCE,
  FLAGSHIP_METADATA_KEY,
  MAX_MAX_FLAGSHIP_SUBAGENTS,
  MIN_MAX_FLAGSHIP_SUBAGENTS,
  effectiveFlagshipLimit,
  isFlagshipModel,
  isFlagshipSession,
  normalizeFlagshipModel,
  normalizeMaxFlagshipSubagents,
  sameFlagshipModel,
  type ModelRef,
} from "./flagship"

export {
  DEFAULT_MAX_FLAGSHIP_SUBAGENTS,
  FLAGSHIP_MARKER_SOURCE,
  FLAGSHIP_METADATA_KEY,
  MAX_MAX_FLAGSHIP_SUBAGENTS,
  MIN_MAX_FLAGSHIP_SUBAGENTS,
  effectiveFlagshipLimit,
  isFlagshipModel,
  isFlagshipSession,
  normalizeFlagshipModel,
  sameFlagshipModel,
}
export type { ModelRef }

export const MAX_FLAGSHIP_SUBAGENTS_KEY = "superagent.max-flagship-subagents"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function entryValue(entries: unknown, key: string): unknown {
  if (!Array.isArray(entries)) return undefined
  for (const entry of entries) {
    if (isRecord(entry) && entry.key === key) return entry.value
  }
  return undefined
}

/**
 * Reads the flagship cap through the shared normalizer: missing, empty or
 * non-integer → 2; integer values are clamped to 0..20. This keeps the panel
 * and the server on exactly the same reading.
 */
export function readMaxFlagshipSubagents(entries: unknown): number {
  const raw = entryValue(entries, MAX_FLAGSHIP_SUBAGENTS_KEY)
  if (typeof raw === "number") return normalizeMaxFlagshipSubagents(raw)
  if (typeof raw === "string" && raw.trim() !== "") return normalizeMaxFlagshipSubagents(raw)
  return DEFAULT_MAX_FLAGSHIP_SUBAGENTS
}

/** Same off-by-one rule as the total cap: in-flight includes the current call. */
export function isFlagshipOverLimit(exist: number, inflight: number, limit: number): boolean {
  return exist + inflight > limit
}

export function flagshipFormula(exist: number, inflight: number, limit: number): string {
  return `flagshipExist=${exist} flagshipInflight=${inflight} flagshipTotal=${exist + inflight} flagshipLimit=${limit}`
}

/** `{ model, at, source }`, the marker written on an explicitly delegated flagship child. */
export type FlagshipMarker = { model: ModelRef; at: number; source: typeof FLAGSHIP_MARKER_SOURCE }

export function withFlagshipMarker(metadata: unknown, model: unknown, at: number): Record<string, unknown> | undefined {
  const ref = normalizeFlagshipModel(model)
  if (!ref) return undefined
  const base = isRecord(metadata) ? metadata : {}
  const marker: FlagshipMarker = { model: ref, at, source: FLAGSHIP_MARKER_SOURCE }
  return { ...base, [FLAGSHIP_METADATA_KEY]: marker }
}

/** Removes the marker while keeping every other metadata key. */
export function withoutFlagshipMarker(
  metadata: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(metadata) || !(FLAGSHIP_METADATA_KEY in metadata)) return undefined
  const next: Record<string, unknown> = { ...metadata }
  delete next[FLAGSHIP_METADATA_KEY]
  return next
}

export function hasFlagshipMarker(metadata: unknown): boolean {
  return isRecord(metadata) && FLAGSHIP_METADATA_KEY in metadata
}

export function flagshipDenyMessage(input: { count: number; limit: number; rootID: string }): string {
  return `旗舰子代理上限已满：当前${input.count}/上限${input.limit}，root=${input.rootID}（运行中/被保护的旗舰不能淘汰；可等完成、调大 superagent.max-flagship-subagents，或用 sessionID 续跑已有旗舰）`
}

export type FlagshipVictimCandidate = {
  id: string
  finished: boolean
  running: boolean
  created?: number
  busy?: number
}

/**
 * Flagship overflow evicts the oldest finished flagship only. Running,
 * steered and protected sessions are never touched; stale (never finished)
 * sessions are not considered either.
 */
export function pickFlagshipVictim(
  flagships: readonly FlagshipVictimCandidate[],
  steered: ReadonlySet<string>,
  kept: ReadonlySet<string>,
): FlagshipVictimCandidate | undefined {
  return flagships
    .filter((child) => child.finished && !child.running)
    .filter((child) => !steered.has(child.id) && !kept.has(child.id))
    .sort((a, b) => (a.created ?? a.busy ?? 0) - (b.created ?? b.busy ?? 0))[0]
}