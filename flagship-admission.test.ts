import { describe, expect, test } from "bun:test"

import {
  DEFAULT_MAX_FLAGSHIP_SUBAGENTS,
  FLAGSHIP_METADATA_KEY,
  MAX_FLAGSHIP_SUBAGENTS_KEY,
  effectiveFlagshipLimit,
  flagshipDenyMessage,
  hasFlagshipMarker,
  isFlagshipModel,
  isFlagshipOverLimit,
  isFlagshipSession,
  pickFlagshipVictim,
  readMaxFlagshipSubagents,
  resolveNewSubagentModel,
  resolveSteerSubagentModel,
  withFlagshipMarker,
  withoutFlagshipMarker,
} from "./flagship-admission"
import { isFlagshipSession as sharedIsFlagshipSession, normalizeMaxFlagshipSubagents } from "./flagship"

const ROOT = { providerID: "acme", id: "flagship", variant: "high" }
const FLASH = "acme/flash"

describe("readMaxFlagshipSubagents", () => {
  test("缺省 2，0 是合法值", () => {
    expect(readMaxFlagshipSubagents([])).toBe(DEFAULT_MAX_FLAGSHIP_SUBAGENTS)
    expect(readMaxFlagshipSubagents([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 0 }])).toBe(0)
  })

  test("合法整数 0..20 原样读取（数字与字符串）", () => {
    for (const value of [0, 1, 2, 20, "3"]) {
      expect(readMaxFlagshipSubagents([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value }])).toBe(Number(value))
    }
  })

  test("非整数与空值回退 2；越界整数按共享规则 clamp", () => {
    for (const value of ["abc", "", 3.5, null, undefined, {}, true]) {
      expect(readMaxFlagshipSubagents([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value }])).toBe(2)
    }
    expect(readMaxFlagshipSubagents([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: -1 }])).toBe(0)
    expect(readMaxFlagshipSubagents([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value: 21 }])).toBe(20)
  })

  test("与面板共用 normalizeMaxFlagshipSubagents 语义", () => {
    for (const value of [undefined, "x", -5, 25, "3"]) {
      expect(readMaxFlagshipSubagents([{ key: MAX_FLAGSHIP_SUBAGENTS_KEY, value }])).toBe(
        normalizeMaxFlagshipSubagents(value),
      )
    }
  })
})

describe("模型解析遵循 native", () => {
  test("新建：input.model ?? agent.model ?? parent.model", () => {
    expect(
      resolveNewSubagentModel({ inputModel: FLASH, agentModel: ROOT, parentModel: FLASH }),
    ).toEqual({ providerID: "acme", id: "flash" })
    expect(resolveNewSubagentModel({ agentModel: ROOT, parentModel: FLASH })).toEqual({
      providerID: "acme",
      id: "flagship",
      variant: "high",
    })
    expect(resolveNewSubagentModel({ parentModel: FLASH })).toEqual({ providerID: "acme", id: "flash" })
  })

  test("新建：空串视作未设置，未知模型返回 undefined", () => {
    expect(resolveNewSubagentModel({ inputModel: "", parentModel: FLASH })).toEqual({
      providerID: "acme",
      id: "flash",
    })
    expect(resolveNewSubagentModel({ inputModel: "not-a-model", parentModel: FLASH })).toBeUndefined()
  })

  test("steer：override ?? (switched ? agent.model : undefined) ?? existing.model", () => {
    expect(
      resolveSteerSubagentModel({ inputModel: FLASH, agentModel: ROOT, existingModel: ROOT, switched: true }),
    ).toEqual({ providerID: "acme", id: "flash" })
    expect(
      resolveSteerSubagentModel({ agentModel: ROOT, existingModel: FLASH, switched: true }),
    ).toEqual({ providerID: "acme", id: "flagship", variant: "high" })
    expect(
      resolveSteerSubagentModel({ agentModel: ROOT, existingModel: FLASH, switched: false }),
    ).toEqual({ providerID: "acme", id: "flash" })
  })

  test("旗舰定义含 variant，未知模型不当作确定旗舰", () => {
    expect(isFlagshipModel(ROOT, ROOT)).toBe(true)
    expect(isFlagshipModel("acme/flagship#high", ROOT)).toBe(true)
    expect(isFlagshipModel("acme/flagship", ROOT)).toBe(false)
    expect(isFlagshipModel("acme/flagship#low", ROOT)).toBe(false)
    expect(isFlagshipModel(undefined, ROOT)).toBe(false)
    expect(isFlagshipModel("broken", ROOT)).toBe(false)
    expect(isFlagshipModel(ROOT, undefined)).toBe(false)
  })
})

describe("旗舰准入公式", () => {
  test("在途含本次调用：exist + inflight <= limit 才放行", () => {
    expect(isFlagshipOverLimit(2, 1, 2)).toBe(true)
    expect(isFlagshipOverLimit(1, 1, 2)).toBe(false)
    expect(isFlagshipOverLimit(0, 1, 0)).toBe(true)
    expect(isFlagshipOverLimit(0, 0, 0)).toBe(false)
  })

  test("总上限更小时总上限优先", () => {
    expect(effectiveFlagshipLimit(5, 3)).toBe(3)
    expect(effectiveFlagshipLimit(2, 5)).toBe(2)
    expect(effectiveFlagshipLimit(0, 5)).toBe(0)
  })

  test("拒绝文案说明 root、上限与出路", () => {
    const message = flagshipDenyMessage({ count: 3, limit: 2, rootID: "ses_root" })
    expect(message).toContain("当前3/上限2")
    expect(message).toContain("ses_root")
    expect(message).toContain("max-flagship-subagents")
  })
})

describe("旗舰标记", () => {
  test("admission 与面板共享同一个 isFlagshipSession 实现", () => {
    expect(isFlagshipSession).toBe(sharedIsFlagshipSession)
  })

  test("写入时保留旧 metadata，清除时只去掉旗舰键", () => {
    const marked = withFlagshipMarker({ keep: 1, "superagent.critic": true }, ROOT, 123)
    expect(marked).toEqual({
      keep: 1,
      "superagent.critic": true,
      [FLAGSHIP_METADATA_KEY]: {
        model: { providerID: "acme", id: "flagship", variant: "high" },
        at: 123,
      },
    })
    expect(hasFlagshipMarker(marked)).toBe(true)
    expect(withoutFlagshipMarker(marked)).toEqual({ keep: 1, "superagent.critic": true })
    expect(withoutFlagshipMarker({ keep: 1 })).toBeUndefined()
  })

  test("持久标记在 child 当前模型一致时保留身份；不一致视为过期", () => {
    const markedRoot = { model: ROOT, metadata: { [FLAGSHIP_METADATA_KEY]: { model: ROOT, at: 1 } } }
    const staleFlash = { model: FLASH, metadata: { [FLAGSHIP_METADATA_KEY]: { model: ROOT, at: 1 } } }
    const plainFlash = { model: FLASH, metadata: {} }
    // root 后来换模型不清洗标记：child 仍与 marker 同模型时仍是旗舰。
    expect(isFlagshipSession(markedRoot, FLASH)).toBe(true)
    // child 已经换到别的模型：旧标记过期，不再算旗舰。
    expect(isFlagshipSession(staleFlash, ROOT)).toBe(false)
    expect(isFlagshipSession(plainFlash, ROOT)).toBe(false)
    expect(isFlagshipSession(plainFlash, FLASH)).toBe(true)
  })
})

describe("旗舰淘汰候选", () => {
  const children = [
    { id: "old", finished: true, running: false, created: 10 },
    { id: "newer", finished: true, running: false, created: 20 },
    { id: "running", finished: false, running: true, created: 1 },
    { id: "stale", finished: false, running: false, created: 0 },
  ]

  test("只选最旧已完成旗舰，restarting/stale 不动", () => {
    expect(pickFlagshipVictim(children, new Set(), new Set())?.id).toBe("old")
  })

  test("steer 中与保护名单里的旗舰不删", () => {
    expect(pickFlagshipVictim(children, new Set(["old"]), new Set())?.id).toBe("newer")
    expect(pickFlagshipVictim(children, new Set(), new Set(["old", "newer"]))).toBeUndefined()
  })

  test("没有已完成旗舰时返回 undefined（调用方显式拒绝）", () => {
    expect(
      pickFlagshipVictim(
        children.filter((child) => !child.finished),
        new Set(),
        new Set(),
      ),
    ).toBeUndefined()
  })
})