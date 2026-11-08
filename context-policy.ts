/**
 * Context warning policy shared by the TUI readout and the server probe.
 * A model with a known context window gets a tighter threshold; models with
 * no window data keep the provider-neutral 300K guideline.
 */

export const DEFAULT_CONTEXT_WARN_TOKENS = 300_000
export const CONTEXT_WARN_RATIO = 0.8

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/** Reads the window from catalog-style (`limit.context`) or provider-style models. */
export function modelContextWindow(model: unknown): number | undefined {
  if (!isRecord(model)) return undefined
  const limit = isRecord(model.limit) ? model.limit : undefined
  return (
    positiveInteger(model.contextWindow) ??
    positiveInteger(model.context_window) ??
    positiveInteger(limit?.context) ??
    positiveInteger(model.context)
  )
}

/**
 * `min(300K, floor(window * 0.8))` when the window is known; otherwise 300K.
 * The reading warns only when it is strictly greater than this threshold.
 */
export function contextWarnThreshold(model?: unknown, fallback = DEFAULT_CONTEXT_WARN_TOKENS): number {
  const window = modelContextWindow(model)
  if (window === undefined) return fallback
  return Math.min(fallback, Math.floor(window * CONTEXT_WARN_RATIO))
}