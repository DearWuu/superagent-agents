import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MAX_FLAGSHIP_SUBAGENTS,
  FLAGSHIP_MARKER_SOURCE,
  FLAGSHIP_METADATA_KEY,
  countFlagshipSubagents,
  effectiveFlagshipLimit,
  isFlagshipModel,
  isFlagshipSession,
  normalizeFlagshipModel,
  normalizeMaxFlagshipSubagents,
  sameFlagshipModel,
} from "./flagship"

describe("normalizeFlagshipModel", () => {
  test("接受 provider/model#variant 与对象形态", () => {
    expect(normalizeFlagshipModel("acme/k3#high")).toEqual({ providerID: "acme", id: "k3", variant: "high" })
    expect(normalizeFlagshipModel({ providerID: "acme", id: "k3", variant: "high" })).toEqual({
      providerID: "acme",
      id: "k3",
      variant: "high",
    })
    expect(normalizeFlagshipModel({ providerID: "acme", modelID: "k3" })).toEqual({ providerID: "acme", id: "k3" })
  })

  test("非法或缺失的模型引用不产生身份", () => {
    expect(normalizeFlagshipModel("")).toBeUndefined()
    expect(normalizeFlagshipModel("acme")).toBeUndefined()
    expect(normalizeFlagshipModel({ providerID: "acme" })).toBeUndefined()
    expect(normalizeFlagshipModel(null)).toBeUndefined()
  })
})

describe("flagship identity", () => {
  test("provider、model 与 variant 全部一致才算同模型", () => {
    expect(isFlagshipModel("acme/k3#high", "acme/k3#high")).toBe(true)
    expect(isFlagshipModel("acme/k3", "acme/k3#high")).toBe(false)
    expect(isFlagshipModel("other/k3#high", "acme/k3#high")).toBe(false)
  })

  test("缺省 variant 与字面 default 等价", () => {
    expect(sameFlagshipModel("acme/k3", "acme/k3#default")).toBe(true)
    expect(sameFlagshipModel("acme/k3#default", "acme/k3")).toBe(true)
    expect(isFlagshipModel({ providerID: "acme", id: "k3" }, { providerID: "acme", id: "k3", variant: "default" })).toBe(
      true,
    )
    expect(sameFlagshipModel("acme/k3#default", "acme/k3#high")).toBe(false)
  })

  test("未知模型不当作确定旗舰", () => {
    expect(isFlagshipModel(undefined, "acme/k3")).toBe(false)
    expect(isFlagshipModel("acme/k3", undefined)).toBe(false)
  })

  test("root 切模型后显式来源标记仍保留旗舰身份", () => {
    const marker = { model: { providerID: "acme", id: "k3" }, at: 1, source: FLAGSHIP_MARKER_SOURCE }
    const oldFlagship = { model: "acme/k3", metadata: { [FLAGSHIP_METADATA_KEY]: marker } }
    expect(isFlagshipSession(oldFlagship, "acme/flash")).toBe(true)
  })

  test("无标记的会话即使与 root 同模型也不是旗舰", () => {
    expect(isFlagshipSession({ model: "acme/k3" }, "acme/k3")).toBe(false)
    expect(isFlagshipSession({ model: "acme/flash" }, "acme/k3")).toBe(false)
  })

  test("显式 false 标记覆盖模型比较", () => {
    expect(isFlagshipSession({ model: "acme/k3", metadata: { [FLAGSHIP_METADATA_KEY]: false } }, "acme/k3")).toBe(false)
  })

  test("只认显式来源的服务端标记；无 source 的 { model, at } 不算旗舰", () => {
    const source = FLAGSHIP_MARKER_SOURCE
    const objectMarker = { model: { providerID: "acme", id: "k3", variant: "high" }, at: 123, source }
    expect(
      isFlagshipSession({ model: "acme/k3#high", metadata: { [FLAGSHIP_METADATA_KEY]: objectMarker } }, "acme/k3#high"),
    ).toBe(true)
    const stringMarker = { model: "acme/k3#high", at: 124, source }
    expect(
      isFlagshipSession({ model: "acme/k3#high", metadata: { [FLAGSHIP_METADATA_KEY]: stringMarker } }, "acme/k3#high"),
    ).toBe(true)
    // 旧自动写入的 { model, at } 没有 source：无法证明显式委派，按普通处理。
    expect(
      isFlagshipSession(
        { model: "acme/k3", metadata: { [FLAGSHIP_METADATA_KEY]: { model: "acme/k3", at: 125 } } },
        "acme/k3",
      ),
    ).toBe(false)
    expect(
      isFlagshipSession(
        { model: "acme/k3", metadata: { [FLAGSHIP_METADATA_KEY]: { model: "not-a-model", at: 126, source } } },
        "acme/k3",
      ),
    ).toBe(false)
  })

  test("旧格式标记（true、裸模型引用、裸模型字符串）全部按普通处理", () => {
    expect(isFlagshipSession({ model: "acme/k3", metadata: { [FLAGSHIP_METADATA_KEY]: true } }, "acme/k3")).toBe(false)
    expect(
      isFlagshipSession(
        { model: "acme/k3", metadata: { [FLAGSHIP_METADATA_KEY]: { providerID: "acme", id: "k3" } } },
        "acme/k3",
      ),
    ).toBe(false)
    expect(isFlagshipSession({ model: "acme/k3", metadata: { [FLAGSHIP_METADATA_KEY]: "acme/k3" } }, "acme/k3")).toBe(
      false,
    )
  })

  test("面板计数识别服务端标记（跨端一致）", () => {
    const marker = { model: { providerID: "acme", id: "k3", variant: "high" }, at: 1, source: FLAGSHIP_MARKER_SOURCE }
    expect(
      countFlagshipSubagents(
        [
          { model: "acme/k3#high", metadata: { [FLAGSHIP_METADATA_KEY]: marker } },
          { model: "acme/k3#high", metadata: { [FLAGSHIP_METADATA_KEY]: false } },
          { model: "acme/k3#high" },
        ],
        "acme/k3#high",
      ),
    ).toBe(1)
  })

  test("计数只认显式来源的有效标记", () => {
    expect(
      countFlagshipSubagents(
        [
          { model: "acme/k3" },
          { model: "acme/flash" },
          { model: "acme/flash", metadata: { [FLAGSHIP_METADATA_KEY]: true } },
          { model: undefined },
        ],
        "acme/k3",
      ),
    ).toBe(0)
    expect(
      countFlagshipSubagents(
        [
          {
            model: "acme/k3",
            metadata: { [FLAGSHIP_METADATA_KEY]: { model: { providerID: "acme", id: "k3" }, at: 2, source: FLAGSHIP_MARKER_SOURCE } },
          },
        ],
        "acme/k3",
      ),
    ).toBe(1)
  })
})

describe("旗舰身份：标记与当前模型", () => {
  const K3 = { providerID: "acme", id: "k3" }
  const FLASH = { providerID: "acme", id: "flash" }
  const MINIMAX = { providerID: "minimax", id: "m2.5" }
  const markerOf = (model: unknown, at = 1) => ({ model, at, source: FLAGSHIP_MARKER_SOURCE })

  test("child 当前模型与 marker.model 不一致时不是旗舰（marker 已过期）", () => {
    const stale = { model: FLASH, metadata: { [FLAGSHIP_METADATA_KEY]: markerOf(K3) } }
    const staleMinimax = { model: MINIMAX, metadata: { [FLAGSHIP_METADATA_KEY]: markerOf(K3) } }
    expect(isFlagshipSession(stale, K3)).toBe(false)
    expect(isFlagshipSession(staleMinimax, K3)).toBe(false)
    expect(countFlagshipSubagents([stale, staleMinimax], K3)).toBe(0)
  })

  test("child 当前模型与 marker.model 一致时按 marker 认定（root 后来换模型不影响）", () => {
    const marked = { model: K3, metadata: { [FLAGSHIP_METADATA_KEY]: markerOf(K3) } }
    expect(isFlagshipSession(marked, FLASH)).toBe(true)
    expect(isFlagshipSession(marked, MINIMAX)).toBe(true)
    expect(countFlagshipSubagents([marked], MINIMAX)).toBe(1)
  })

  test("false 标记永不是旗舰", () => {
    expect(isFlagshipSession({ model: K3, metadata: { [FLAGSHIP_METADATA_KEY]: false } }, K3)).toBe(false)
  })

  test("无标记会话不因与 root 同模型而成为旗舰", () => {
    expect(isFlagshipSession({ model: K3 }, K3)).toBe(false)
    expect(isFlagshipSession({ model: FLASH }, K3)).toBe(false)
  })

  test("缺省 variant 与字面 default 等价", () => {
    const marked = { model: K3, metadata: { [FLAGSHIP_METADATA_KEY]: markerOf({ ...K3, variant: "default" }) } }
    expect(isFlagshipSession(marked, K3)).toBe(true)
    expect(isFlagshipSession(marked, FLASH)).toBe(true)
  })

  test("当前模型未知时有效 marker 仍然成立", () => {
    const marked = { model: undefined, metadata: { [FLAGSHIP_METADATA_KEY]: markerOf(K3) } }
    expect(isFlagshipSession(marked, FLASH)).toBe(true)
  })

  test("Flash 子代理不被旧 marker 计入旗舰", () => {
    const staleNoSource = { model: FLASH, metadata: { [FLAGSHIP_METADATA_KEY]: { model: K3, at: 1 } } }
    const staleExpired = { model: FLASH, metadata: { [FLAGSHIP_METADATA_KEY]: markerOf(K3) } }
    const plain = { model: FLASH }
    expect(countFlagshipSubagents([staleNoSource, staleExpired, plain], K3)).toBe(0)
  })
})

describe("flagship limit", () => {
  test("默认 2，合法范围 0..20", () => {
    expect(DEFAULT_MAX_FLAGSHIP_SUBAGENTS).toBe(2)
    expect(normalizeMaxFlagshipSubagents(undefined)).toBe(2)
    expect(normalizeMaxFlagshipSubagents(-1)).toBe(0)
    expect(normalizeMaxFlagshipSubagents(21)).toBe(20)
    expect(normalizeMaxFlagshipSubagents("3")).toBe(3)
    expect(normalizeMaxFlagshipSubagents("x")).toBe(2)
  })

  test("旗舰上限受子代理总上限约束", () => {
    expect(effectiveFlagshipLimit(5, 3)).toBe(3)
    expect(effectiveFlagshipLimit(2, 5)).toBe(2)
    expect(effectiveFlagshipLimit(0, 5)).toBe(0)
  })
})