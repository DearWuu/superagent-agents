/**
 * 默认模型派工的纯逻辑：从 root 指令条目读默认策略，结合每子代理策略与
 * 续跑子会话的当前模型，判定本次派工是否要注入目标模型。
 *
 * 上游是 server.ts 的派工接线（读条目、读会话、校验可用性都由它注入）；
 * 本模块只做判定，不做 I/O。
 */

import {
  isExplicitModelDelegation,
  normalizeModelDelegationModel,
  sameModelDelegationModel,
} from "./model-delegation"
import type { ModelRef } from "./model-policy"
import { DEFAULT_MODEL_KEY, DEFAULT_POLICY_KEY, asArray, isObject } from "./server-state"

/** root 默认策略：`fixed` / `inherit` / `auto`；条目缺失或缺省推断见 `readDefaultPolicy`。 */
export type DefaultPolicy = "fixed" | "inherit" | "auto" | "unset"

export type DefaultPolicyState = { policy: DefaultPolicy; model?: ModelRef }

/** 每子代理策略写在子会话 metadata 上，只管该子代理后续分配。 */
export const MODEL_POLICY_METADATA_KEY = "superagent.model-policy"

export type PerChildPolicy = "auto" | "inherit" | "fixed"

/** 判定来源：显式委派、每子代理策略、root 策略与「目标与当前模型相同」。 */
export type DispatchModelReason =
  | "explicit"
  | "delegated"
  | "per-child-auto"
  | "per-child-fixed"
  | "fixed"
  | "inherit"
  | "same"
  | "auto"
  | "unset"

export type ResolveDispatchModelInput = {
  policy: DefaultPolicy
  defaultModel?: unknown
  rootModel?: unknown
  explicitModel?: unknown
  steer: boolean
  child?: { model?: unknown; metadata?: Record<string, unknown> }
}

/**
 * 读 root 的默认策略。条目缺失或取值不认识时按兼容口径推断：
 * 有 `default-model` 按 `fixed`，都没有按 `unset`。
 */
export function readDefaultPolicy(entries: unknown): DefaultPolicyState {
  const list = asArray(entries)
  const model = normalizeModelDelegationModel(list.find((item) => item?.key === DEFAULT_MODEL_KEY)?.value)
  const raw = list.find((item) => item?.key === DEFAULT_POLICY_KEY)?.value
  const policy = typeof raw === "string" ? raw.trim().toLowerCase() : undefined
  if (policy === "fixed") return model ? { policy, model } : { policy }
  if (policy === "inherit" || policy === "auto") return { policy }
  return model ? { policy: "fixed", model } : { policy: "unset" }
}

/** 子会话 metadata 上的每子代理策略；缺失或取值不认识返回 undefined。 */
export function readPerChildPolicy(metadata: Record<string, unknown> | undefined): PerChildPolicy | undefined {
  const raw = metadata?.[MODEL_POLICY_METADATA_KEY]
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : undefined
  return value === "auto" || value === "inherit" || value === "fixed" ? value : undefined
}

/**
 * 判定本次派工是否注入目标模型。优先级从高到低：
 * 显式 `input.model` → 有效显式委派标记 → 每子代理策略 → root 策略；
 * 最后对续跑做一次「目标与子会话当前模型相同」的短路。
 */
export function resolveDispatchModel(
  input: ResolveDispatchModelInput,
): { target?: ModelRef; reason: DispatchModelReason } {
  if (normalizeModelDelegationModel(input.explicitModel)) return { reason: "explicit" }

  if (input.steer) {
    if (isExplicitModelDelegation({ model: input.child?.model, metadata: input.child?.metadata })) {
      return { reason: "delegated" }
    }
    const perChild = readPerChildPolicy(input.child?.metadata)
    if (perChild === "auto") return { reason: "per-child-auto" }
    if (perChild === "fixed") return { reason: "per-child-fixed" }
    if (perChild === "inherit") {
      return conclude(normalizeModelDelegationModel(input.rootModel), "inherit", input)
    }
  }

  if (input.policy === "fixed") {
    return conclude(normalizeModelDelegationModel(input.defaultModel), "fixed", input)
  }
  if (input.policy === "inherit") {
    return conclude(normalizeModelDelegationModel(input.rootModel), "inherit", input)
  }
  return { reason: input.policy === "auto" ? "auto" : "unset" }
}

function conclude(
  target: ModelRef | undefined,
  reason: "fixed" | "inherit",
  input: ResolveDispatchModelInput,
): { target?: ModelRef; reason: DispatchModelReason } {
  if (!target) return { reason }
  // 新建不做同模型短路：首步就要落在目标模型上，宿主不会自行切换。
  if (input.steer && input.child && sameModelDelegationModel(target, input.child.model)) {
    return { reason: "same" }
  }
  return { target, reason }
}

/** 把 `ctx.model.list()` 的返回值摊成 `providerID/modelID` 集合。 */
export function collectModelKeys(output: unknown): Set<string> {
  const items = asArray(isObject(output) && Array.isArray(output.data) ? output.data : output)
  const keys = new Set<string>()
  for (const item of items) {
    const providerID = typeof item?.providerID === "string" ? item.providerID : undefined
    const id =
      typeof item?.id === "string" ? item.id : typeof item?.modelID === "string" ? item.modelID : undefined
    if (providerID && id) keys.add(`${providerID}/${id}`)
  }
  return keys
}

/** 目标模型是否在可用列表里；variant 不参与可用性判定。 */
export function isModelAvailable(keys: Set<string>, ref: ModelRef): boolean {
  return keys.has(`${ref.providerID}/${ref.id}`)
}
