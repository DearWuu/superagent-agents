/** TUI 面板共享的模型、会话与动作类型；只放类型，不引入运行时依赖。 */

import type { ModelRef } from "./model-policy"
import type { OversightLevel } from "./oversight"

export type ModelInfo = {
  providerID: string
  id: string
  name?: string
  description?: string
  variants?: Array<{ id: string }>
  enabled?: boolean
  status?: string
  cost?: Array<{ input: number; output?: number }>
}
export type ProviderInfo = { id: string; name: string }
export type SessionInfo = {
  id: string
  parentID?: string
  title?: string
  agent?: string
  model?: ModelRef
  location?: unknown
  outcome?: string
  metadata?: Record<string, unknown>
  time?: { created: number; updated: number; archived?: number; busy?: number; idle?: number }
}
export type Policy = "auto" | "inherit" | "fixed"

export type ModelChoice =
  | { kind: "auto" }
  | { kind: "inherit" }
  | { kind: "model"; model: ModelInfo }
  | { kind: "configure" }

export type SettingsAction =
  | { kind: "collabSwitch" }
  | { kind: "oversight" }
  | { kind: "policy" }
  | { kind: "maxSubagents" }
  | { kind: "maxFlagshipSubagents" }
  | { kind: "assignmentPrompt" }
  | { kind: "taskPrompt" }
  | { kind: "restore" }
  | { kind: "defaults" }
  | { kind: "auto" }
  | { kind: "fallbackModel" }
  | { kind: "subagentFallbackModel" }
  | { kind: "fallbackEnabled" }
  | { kind: "criticEnabled" }
  | { kind: "statusWatch" }

export type FallbackAction = { kind: "on" } | { kind: "off" } | { kind: "threshold" }

export type PolicyAction = { kind: "report" } | { kind: "prompt" } | { kind: "close" }
export type DefaultAction = { kind: "auto" } | { kind: "inherit" } | { kind: "choose" } | { kind: "configure" }
export type OversightAction = { kind: "default" } | { kind: "pin"; level: OversightLevel }
export type AgentAction =
  | { kind: "model" }
  | { kind: "open" }
  | { kind: "delete" }
  | { kind: "compact" }
  | { kind: "keep" }
