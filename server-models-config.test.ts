/**
 * server-models 的纯逻辑回归：
 *  - 窗口内累计限额失败达到阈值立即切换，未达阈值等窗口到期（B1）；
 *  - 配置解析容错（B4）、限额判定文本兜底收窄（B6）；
 *  - 同 root 并发降档串行（B5）、切换失败重 arm 复位窗口（B8）。
 */
import { describe, expect, test } from "bun:test"

import { createQuotaFallback, isQuotaFailure, readFallbackConfig, type RetryFailure } from "./server-models"
import {
  DEFAULT_FALLBACK_THRESHOLD,
  FALLBACK_ENABLED_KEY,
  FALLBACK_MODEL_KEY,
  FALLBACK_THRESHOLD_KEY,
  MAX_SUBAGENTS_KEY,
  SUBAGENT_FALLBACK_MODEL_KEY,
} from "./server-state"

const quotaError = { type: "provider.quota", message: "quota exceeded" }

function entriesWith(values: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    [MAX_SUBAGENTS_KEY]: 5,
    [FALLBACK_ENABLED_KEY]: "true",
    [FALLBACK_MODEL_KEY]: "acme/backup",
    [SUBAGENT_FALLBACK_MODEL_KEY]: "acme/backup",
    [FALLBACK_THRESHOLD_KEY]: 3,
  }
  return Object.entries({ ...base, ...values }).map(([key, value]) => ({ key, value }))
}

function failure(sessionID: string, entries: any[]): RetryFailure {
  return {
    sessionID,
    rootID: "ses_root",
    isRoot: false,
    error: quotaError,
    model: { providerID: "acme", id: "big" },
    entries,
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await sleep(5)
  return check()
}

describe("B1 阈值参与判定：达到阈值立即切，否则窗口到期切", () => {
  test("threshold=3：前两次只计时，第三次立即切一次", async () => {
    const switched: string[] = []
    const fallback = createQuotaFallback({
      switchModel: async ({ model }) => {
        switched.push(`${model.providerID}/${model.id}`)
      },
      writeLimit: async () => {},
      log: () => {},
      timeoutMs: 60_000,
      tierDown: false,
    })
    const entries = entriesWith({ [FALLBACK_THRESHOLD_KEY]: 3 })
    const input = failure("ses_child", entries)

    expect((await fallback.onFailure(input)).switched).toBe(false)
    expect(fallback.isArmed("ses_child")).toBe(true)
    expect((await fallback.onFailure(input)).switched).toBe(false)
    expect(switched).toHaveLength(0)
    expect((await fallback.onFailure(input)).switched).toBe(true)
    expect(switched).toEqual(["acme/backup"])
    expect(fallback.isArmed("ses_child")).toBe(false)
    fallback.dispose()
  })

  test("threshold=1：首个失败即切，不等窗口", async () => {
    const switched: string[] = []
    const fallback = createQuotaFallback({
      switchModel: async ({ model }) => {
        switched.push(`${model.providerID}/${model.id}`)
      },
      writeLimit: async () => {},
      log: () => {},
      timeoutMs: 60_000,
      tierDown: false,
    })
    const input = failure("ses_child", entriesWith({ [FALLBACK_THRESHOLD_KEY]: 1 }))
    expect((await fallback.onFailure(input)).switched).toBe(true)
    expect(switched).toEqual(["acme/backup"])
    fallback.dispose()
  })

  test("未达阈值时维持 60 秒窗口到期切换", async () => {
    const switched: string[] = []
    const fallback = createQuotaFallback({
      switchModel: async ({ model }) => {
        switched.push(`${model.providerID}/${model.id}`)
      },
      writeLimit: async () => {},
      log: () => {},
      timeoutMs: 25,
      tierDown: false,
    })
    expect((await fallback.onFailure(failure("ses_child", entriesWith()))).switched).toBe(false)
    expect(fallback.isArmed("ses_child")).toBe(true)
    expect(await waitFor(() => switched.length === 1)).toBe(true)
    fallback.dispose()
  })

  test("窗口内成功恢复：不再切", async () => {
    const switched: string[] = []
    const fallback = createQuotaFallback({
      switchModel: async ({ model }) => {
        switched.push(`${model.providerID}/${model.id}`)
      },
      writeLimit: async () => {},
      log: () => {},
      timeoutMs: 30,
      tierDown: false,
    })
    await fallback.onFailure(failure("ses_child", entriesWith()))
    fallback.reset("ses_child")
    await sleep(80)
    expect(switched).toHaveLength(0)
    fallback.dispose()
  })
})

describe("B4 readFallbackConfig 解析容错", () => {
  const enabledOf = (value: unknown) => readFallbackConfig([{ key: FALLBACK_ENABLED_KEY, value }]).enabled
  const thresholdOf = (value: unknown) => readFallbackConfig([{ key: FALLBACK_THRESHOLD_KEY, value }]).threshold

  test("enabled：缺省启用；off/no/空串/false/0 停用", () => {
    expect(readFallbackConfig([]).enabled).toBe(true)
    for (const value of ["off", "no", "", "false", "0", 0, false]) expect(enabledOf(value)).toBe(false)
    for (const value of [true, "true", "on", 1]) expect(enabledOf(value)).toBe(true)
  })

  test("threshold：只认正整数，布尔/小数/非数字回落缺省", () => {
    expect(thresholdOf("5")).toBe(5)
    expect(thresholdOf(5)).toBe(5)
    expect(thresholdOf(" 7 ")).toBe(7)
    for (const value of [0, -1, 1.5, "1.5", "abc", "", true, false, null, undefined]) {
      expect(thresholdOf(value)).toBe(DEFAULT_FALLBACK_THRESHOLD)
    }
    expect(readFallbackConfig([]).threshold).toBe(DEFAULT_FALLBACK_THRESHOLD)
  })

  test("两个备用模型解析", () => {
    const config = readFallbackConfig(entriesWith())
    expect(config.rootModel).toEqual({ providerID: "acme", id: "backup" })
    expect(config.subModel).toEqual({ providerID: "acme", id: "backup" })
    const empty = readFallbackConfig([])
    expect(empty.rootModel).toBeUndefined()
    expect(empty.subModel).toBeUndefined()
  })
})

describe("B6 isQuotaFailure 文本兜底收窄", () => {
  test("明确的非限额类型：消息含 quota 也不判限额", () => {
    expect(isQuotaFailure({ type: "provider.invalid-request", message: "quota exceeded" })).toBe(false)
    expect(isQuotaFailure({ type: "provider.auth", message: "insufficient_quota" })).toBe(false)
    expect(isQuotaFailure({ type: "aborted", message: "quota exceeded" })).toBe(false)
  })

  test("限额类型与 429 仍为 true", () => {
    expect(isQuotaFailure({ type: "provider.quota" })).toBe(true)
    expect(isQuotaFailure({ type: "provider.rate-limit" })).toBe(true)
    expect(isQuotaFailure({ type: "provider.invalid-request", status: 429 })).toBe(true)
  })

  test("类型缺失或无信息类型才走文本兜底", () => {
    expect(isQuotaFailure({ message: "insufficient_quota" })).toBe(true)
    expect(isQuotaFailure({ type: "unknown", message: "rate limit exceeded" })).toBe(true)
    expect(isQuotaFailure({ type: "provider.server-error", message: "quota exceeded" })).toBe(true)
    expect(isQuotaFailure({ type: "provider.transport", message: "ECONNRESET" })).toBe(false)
  })
})

describe("B5 同 root 并发降档串行", () => {
  test("两个会话同时到期：上限依次 5→4→3，而不是两次都写 4", async () => {
    const written: number[] = []
    const store = { limit: 5 }
    const fallback = createQuotaFallback({
      switchModel: async () => {},
      writeLimit: async ({ limit }) => {
        await sleep(5)
        store.limit = limit
        written.push(limit)
      },
      readEntries: async () => entriesWith({ [MAX_SUBAGENTS_KEY]: store.limit }),
      log: () => {},
      timeoutMs: 60_000,
      tierDown: true,
    })
    const entries = entriesWith({ [FALLBACK_THRESHOLD_KEY]: 1 })
    await Promise.all([
      fallback.onFailure(failure("ses_a", entries)),
      fallback.onFailure(failure("ses_b", entries)),
    ])
    expect(written).toEqual([4, 3])
    expect(store.limit).toBe(3)
    fallback.dispose()
  })
})

describe("B8 切换失败重 arm 复位窗口起点", () => {
  test("首次到期切换失败后，新窗口未到期的新失败不得立即触发第二次切换", async () => {
    let attempts = 0
    const fallback = createQuotaFallback({
      switchModel: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("switch down")
      },
      writeLimit: async () => {},
      log: () => {},
      timeoutMs: 100,
      maxSwitchAttempts: 2,
      tierDown: false,
    })
    const entries = entriesWith({ [FALLBACK_THRESHOLD_KEY]: 3 })
    const input = failure("ses_child", entries)
    await fallback.onFailure(input)
    // 第一个窗口到期：首次切换失败并重 arm（armedAt 复位）。
    expect(await waitFor(() => attempts === 1)).toBe(true)
    await sleep(10)
    // 新窗口未到期：这次失败不得当场触发第二次切换。
    await fallback.onFailure(input)
    expect(attempts).toBe(1)
    // 新窗口到期后才发起第二次尝试。
    expect(await waitFor(() => attempts === 2)).toBe(true)
    fallback.dispose()
  })
})