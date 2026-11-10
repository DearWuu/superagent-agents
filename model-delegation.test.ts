/**
 * 显式模型委派标记的纯逻辑：来源、模型写入与「当前模型仍匹配才有效」。
 * 旗舰身份与这里是两套标记，互不相互推导。
 */
import { describe, expect, test } from "bun:test"

import { isFlagshipSession } from "./flagship"
import {
  MODEL_DELEGATION_MARKER_SOURCE,
  MODEL_DELEGATION_METADATA_KEY,
  isExplicitModelDelegation,
  normalizeModelDelegationModel,
  sameModelDelegationModel,
  withModelDelegationMarker,
} from "./model-delegation"

const KIMI_HIGH = { providerID: "kimi", id: "k3.1-pro", variant: "high" }
const KIMI = { providerID: "kimi", id: "k3.1-pro" }
const QODER = { providerID: "qoder", id: "qwen3-8-flash" }

function marker(model: unknown, source = MODEL_DELEGATION_MARKER_SOURCE) {
  return { [MODEL_DELEGATION_METADATA_KEY]: { model, at: 1, source } }
}

describe("显式模型委派标记", () => {
  test("规范化字符串与对象两种模型写法", () => {
    expect(normalizeModelDelegationModel("kimi/k3.1-pro#high")).toEqual(KIMI_HIGH)
    expect(normalizeModelDelegationModel("kimi/k3.1-pro")).toEqual(KIMI)
    expect(normalizeModelDelegationModel({ providerID: "qoder", modelID: "qwen3-8-flash" })).toEqual(QODER)
    expect(normalizeModelDelegationModel("kimi/")).toBeUndefined()
    expect(normalizeModelDelegationModel("")).toBeUndefined()
  })

  test("缺省 variant 与字面 default 等价", () => {
    expect(sameModelDelegationModel(KIMI, { ...KIMI, variant: "default" })).toBe(true)
    expect(sameModelDelegationModel(KIMI, KIMI_HIGH)).toBe(false)
  })

  test("写入保留其他 metadata，非法模型不写", () => {
    const next = withModelDelegationMarker({ keep: true }, "kimi/k3.1-pro", 7)
    expect(next).toMatchObject({
      keep: true,
      [MODEL_DELEGATION_METADATA_KEY]: { model: KIMI, at: 7, source: MODEL_DELEGATION_MARKER_SOURCE },
    })
    expect(withModelDelegationMarker(undefined, "invalid", 7)).toBeUndefined()
  })

  test("只有来源匹配、模型合法且与当前模型一致才有效", () => {
    expect(isExplicitModelDelegation({ model: KIMI, metadata: marker(KIMI) })).toBe(true)
    expect(isExplicitModelDelegation({ model: KIMI_HIGH, metadata: marker(KIMI_HIGH) })).toBe(true)
    expect(isExplicitModelDelegation({ model: QODER, metadata: marker(KIMI) })).toBe(false)
    expect(isExplicitModelDelegation({ model: KIMI, metadata: marker(KIMI, "other") })).toBe(false)
    expect(isExplicitModelDelegation({ model: KIMI, metadata: {} })).toBe(false)
    expect(isExplicitModelDelegation({ model: KIMI, metadata: marker({ providerID: "kimi" }) })).toBe(false)
    expect(isExplicitModelDelegation({ metadata: marker(KIMI) })).toBe(false)
  })

  test("委派标记不是旗舰身份", () => {
    const metadata = marker(KIMI_HIGH)
    expect(isFlagshipSession({ model: KIMI_HIGH, metadata })).toBe(false)
  })
})