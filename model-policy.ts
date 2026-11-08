export type ModelRef = {
  providerID: string
  id: string
  variant?: string
}

export type TaskModelPolicy = { kind: "auto" } | { kind: "inherit" } | { kind: "fixed"; model: ModelRef }

export type GlobalModelSettings = {
  /**
   * The only models an `auto` task may use. This is global configuration, not
   * session configuration. An empty list disables auto selection.
   */
  autoModels: readonly ModelRef[]
  /** Used when a task has no policy and no user pin. */
  defaultModel?: ModelRef
}

export type TaskInfo = {
  id: string
  title: string
  complexity?: "low" | "medium" | "high"
}

export type AutoSelectInput = {
  task: TaskInfo
  candidates: readonly ModelRef[]
}

export type AutoSelector = (input: AutoSelectInput) => ModelRef | undefined | Promise<ModelRef | undefined>

export type ModelSelectionSource = "user-pin" | "task-fixed" | "auto" | "inherit" | "default"

export type ModelSelection = {
  model: ModelRef
  source: ModelSelectionSource
  candidates?: readonly ModelRef[]
}

export type ModelPolicyErrorCode =
  | "user-pin-unavailable"
  | "task-model-unavailable"
  | "auto-disabled"
  | "auto-no-choice"
  | "auto-choice-not-configured"
  | "inherit-unavailable"
  | "default-unavailable"
  | "no-model"

export class ModelPolicyError extends Error {
  readonly code: ModelPolicyErrorCode

  constructor(code: ModelPolicyErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = "ModelPolicyError"
  }
}

export function modelKey(model: ModelRef) {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

export function sameModel(a: ModelRef, b: ModelRef) {
  // Providers may materialize an omitted variant as the literal "default".
  // Treat both forms as the same selection so reloads never re-switch a session.
  const variant = (model: ModelRef) => model.variant === "default" ? "" : (model.variant ?? "")
  return a.providerID === b.providerID && a.id === b.id && variant(a) === variant(b)
}

export function uniqueModels(models: readonly ModelRef[]): ModelRef[] {
  const seen = new Set<string>()
  const result: ModelRef[] = []
  for (const model of models) {
    const key = modelKey(model)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...model })
  }
  return result
}

export function availableCandidates(autoModels: readonly ModelRef[], available: readonly ModelRef[]): ModelRef[] {
  return uniqueModels(autoModels).filter((candidate) => available.some((model) => sameModel(model, candidate)))
}

/**
 * Resolves the model for one Assignment.
 *
 * `auto` is evaluated per Assignment. It may only choose from the global
 * superagent auto-model list; it never has access to the whole catalog.
 */
export async function resolveTaskModel(input: {
  task: TaskInfo
  policy?: TaskModelPolicy
  userPin?: ModelRef
  orchestrator: ModelRef
  settings: GlobalModelSettings
  available: readonly ModelRef[]
  selectAuto?: AutoSelector
}): Promise<ModelSelection> {
  const available = uniqueModels(input.available)
  const isAvailable = (model: ModelRef) => available.some((item) => sameModel(item, model))

  if (input.userPin) {
    if (!isAvailable(input.userPin)) {
      throw new ModelPolicyError(
        "user-pin-unavailable",
        `The pinned model ${modelKey(input.userPin)} is not available.`,
      )
    }
    return { model: { ...input.userPin }, source: "user-pin" }
  }

  if (input.policy?.kind === "fixed") {
    if (!isAvailable(input.policy.model)) {
      throw new ModelPolicyError(
        "task-model-unavailable",
        `The task model ${modelKey(input.policy.model)} is not available.`,
      )
    }
    return { model: { ...input.policy.model }, source: "task-fixed" }
  }

  if (input.policy?.kind === "auto") {
    if (input.settings.autoModels.length === 0) {
      throw new ModelPolicyError(
        "auto-disabled",
        "Auto model selection is disabled because no global auto models are configured.",
      )
    }
    const candidates = availableCandidates(input.settings.autoModels, available)
    if (candidates.length === 0) {
      throw new ModelPolicyError(
        "auto-disabled",
        "None of the globally configured auto models are available in this project.",
      )
    }
    if (!input.selectAuto) {
      throw new ModelPolicyError("auto-no-choice", "Auto model selection requires a selector.")
    }
    const choice = await input.selectAuto({ task: input.task, candidates })
    if (!choice) {
      throw new ModelPolicyError("auto-no-choice", "The superagent did not choose an auto model.")
    }
    if (!candidates.some((candidate) => sameModel(candidate, choice))) {
      throw new ModelPolicyError(
        "auto-choice-not-configured",
        `The chosen model ${modelKey(choice)} is not in the global auto model list.`,
      )
    }
    return { model: { ...choice }, source: "auto", candidates }
  }

  if (input.policy?.kind === "inherit") {
    if (!isAvailable(input.orchestrator)) {
      throw new ModelPolicyError(
        "inherit-unavailable",
        `The orchestrator model ${modelKey(input.orchestrator)} is not available.`,
      )
    }
    return { model: { ...input.orchestrator }, source: "inherit" }
  }

  if (input.settings.defaultModel) {
    if (!isAvailable(input.settings.defaultModel)) {
      throw new ModelPolicyError(
        "default-unavailable",
        `The default worker model ${modelKey(input.settings.defaultModel)} is not available.`,
      )
    }
    return { model: { ...input.settings.defaultModel }, source: "default" }
  }

  throw new ModelPolicyError("no-model", "No worker model policy, pin, or default is configured.")
}
