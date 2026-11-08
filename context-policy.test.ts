import { describe, expect, test } from "bun:test"
import {
  DEFAULT_CONTEXT_WARN_TOKENS,
  contextWarnThreshold,
  modelContextWindow,
} from "./context-policy"

describe("context warn threshold", () => {
  test("无窗口数据保持 300K", () => {
    expect(DEFAULT_CONTEXT_WARN_TOKENS).toBe(300_000)
    expect(contextWarnThreshold(undefined)).toBe(300_000)
    expect(contextWarnThreshold({})).toBe(300_000)
    expect(contextWarnThreshold({ limit: { context: 0 } })).toBe(300_000)
  })

  test("128K 窗口按 80% 取整", () => {
    expect(contextWarnThreshold({ limit: { context: 128_000 } })).toBe(102_400)
    expect(contextWarnThreshold({ contextWindow: 128_000 })).toBe(102_400)
    expect(contextWarnThreshold({ context: 128_000 })).toBe(102_400)
  })

  test("窗口大于 375K 时仍封顶 300K", () => {
    expect(contextWarnThreshold({ limit: { context: 1_000_000 } })).toBe(300_000)
    expect(contextWarnThreshold({ limit: { context: 375_000 } })).toBe(300_000)
    expect(contextWarnThreshold({ limit: { context: 375_001 } })).toBe(300_000)
  })

  test("窗口读取兼容 limit.context 与 contextWindow", () => {
    expect(modelContextWindow({ limit: { context: 64_000 } })).toBe(64_000)
    expect(modelContextWindow({ contextWindow: 32_000 })).toBe(32_000)
    expect(modelContextWindow({ context: -1 })).toBeUndefined()
  })
})