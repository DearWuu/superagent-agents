import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  claimCriticReview,
  claimProbe,
  createProbeScanner,
  createQuotaFallback,
  denyMessage,
  downgradeLimit,
  isEnabledValue,
  isQuotaFailure,
  isOverLimit,
  parseKeptSubagents,
  parseModelRef,
  pickVictim,
  PROBE_AFTER_MS,
  PROBE_INTERVAL_MS,
  PROBE_TEXT,
  QUOTA_LIMIT_FLOOR,
  readCriticEnabled,
  readFallbackConfig,
  readMaxSubagents,
  shouldCriticReview,
  shouldProbe,
  startProbeTimer,
  forceRetryAfterSwitch,
  FALLBACK_RETRY_DELAY_MS,
  STALE_AFTER_MS,
  toChild,
  toProbeCandidate,
  type Child,
  type ProbeCandidate,
} from "./server"
import { CRITIC_TITLE_PREFIX } from "./critic"

const NOW = 1_800_000_000_000

function child(overrides: Partial<Child> = {}): Child {
  return {
    id: "ses_a",
    outcome: null,
    created: NOW - 10_000,
    running: false,
    finished: false,
    stale: false,
    ...overrides,
  }
}

describe("isOverLimit", () => {
  test("计数含本次调用自己的槽：5 个存在 + 1 在途 = 6 > 5，需要先淘汰", () => {
    expect(isOverLimit(5, 1, 5)).toBe(true)
  })

  test("放行后共存的子代理数不超过上限", () => {
    // 4 个存在 + 本次 1 个 = 5，恰好达到上限，不必淘汰。
    expect(isOverLimit(4, 1, 5)).toBe(false)
    // 本次调用还没占槽时，5 个存在也算达标。
    expect(isOverLimit(5, 0, 5)).toBe(false)
  })

  test("并发调用会一起把总数顶过上限", () => {
    expect(isOverLimit(4, 2, 5)).toBe(true)
    expect(isOverLimit(3, 2, 5)).toBe(false)
  })

  test("上限覆盖到 1 时同样成立", () => {
    expect(isOverLimit(0, 1, 1)).toBe(false)
    expect(isOverLimit(1, 1, 1)).toBe(true)
  })
})

describe("toChild", () => {
  test("busy 晚于 idle 即仍在运行", () => {
    const item = toChild({ id: "ses_run", time: { created: NOW - 1000, busy: NOW - 500, idle: NOW - 900 } }, NOW)
    expect(item.running).toBe(true)
    expect(item.finished).toBe(false)
    expect(item.stale).toBe(false)
  })

  test("有 busy 没有 idle 即仍在运行", () => {
    const item = toChild({ id: "ses_run", time: { created: NOW - 1000, busy: NOW - 500 } }, NOW)
    expect(item.running).toBe(true)
    expect(item.stale).toBe(false)
  })

  test("outcome 有值即已结束，且 idle 已推到 busy 之后时不算运行中", () => {
    const item = toChild(
      { id: "ses_done", outcome: "succeeded", time: { created: NOW - 5000, busy: NOW - 4000, idle: NOW - 3000 } },
      NOW,
    )
    expect(item.finished).toBe(true)
    expect(item.running).toBe(false)
    expect(item.stale).toBe(false)
  })

  test("已结束但又被 steer 起来（busy 晚于 idle）仍算运行中，不进淘汰候选", () => {
    const item = toChild(
      { id: "ses_steered", outcome: "succeeded", time: { created: NOW - 5000, busy: NOW - 100, idle: NOW - 3000 } },
      NOW,
    )
    expect(item.finished).toBe(true)
    expect(item.running).toBe(true)
    expect(item.stale).toBe(false)
  })

  test("开了工、没有 idle、也没有 outcome，超过阈值即僵尸", () => {
    const item = toChild({ id: "ses_zombie", time: { created: NOW - STALE_AFTER_MS - 1000, busy: NOW - STALE_AFTER_MS - 1000 } }, NOW)
    expect(item.stale).toBe(true)
  })

  test("僵尸阈值是严格大于：恰好阈值不淘汰", () => {
    expect(toChild({ id: "ses_x", time: { created: NOW - STALE_AFTER_MS, busy: NOW - STALE_AFTER_MS } }, NOW).stale).toBe(false)
    expect(toChild({ id: "ses_y", time: { created: NOW - STALE_AFTER_MS - 1, busy: NOW - STALE_AFTER_MS - 1 } }, NOW).stale).toBe(
      true,
    )
  })

  test("有 idle 或已结束的子会话不会按僵尸处理", () => {
    expect(toChild({ id: "ses_x", time: { created: NOW - STALE_AFTER_MS * 2, busy: NOW - STALE_AFTER_MS * 2, idle: NOW - STALE_AFTER_MS } }, NOW).stale).toBe(
      false,
    )
    expect(
      toChild({ id: "ses_y", outcome: "failed", time: { created: NOW - STALE_AFTER_MS * 2, busy: NOW - STALE_AFTER_MS * 2 } }, NOW).stale,
    ).toBe(false)
  })

  test("归档时间存在时由 listChildren 过滤，toChild 自身只做标注", () => {
    const item = toChild({ id: "ses_arch", time: { created: NOW, archived: NOW } }, NOW)
    expect(item.id).toBe("ses_arch")
    expect(item.running).toBe(false)
  })
})

describe("parseKeptSubagents", () => {
  test("逗号分隔，去空白与空项", () => {
    expect(parseKeptSubagents(" ses_a , ,ses_b ")).toEqual(["ses_a", "ses_b"])
  })

  test("空串与非字符串等同无保护", () => {
    expect(parseKeptSubagents("")).toEqual([])
    expect(parseKeptSubagents(undefined)).toEqual([])
    expect(parseKeptSubagents(42)).toEqual([])
    expect(parseKeptSubagents(null)).toEqual([])
  })

  test("数组值同样可用", () => {
    expect(parseKeptSubagents(["ses_a", " ses_b "])).toEqual(["ses_a", "ses_b"])
  })

  test("只有逗号时无保护", () => {
    expect(parseKeptSubagents(", ,")).toEqual([])
  })
})

describe("pickVictim", () => {
  const none = new Set<string>()

  test("已结束的最旧优先，运行中的不碰", () => {
    const children = [
      child({ id: "ses_run", running: true }),
      child({ id: "ses_new", finished: true, created: NOW - 1000 }),
      child({ id: "ses_old", finished: true, created: NOW - 9000 }),
    ]
    expect(pickVictim(children, none, none)?.child.id).toBe("ses_old")
  })

  test("保护名单里的最旧已结束子会话被跳过，选下一个", () => {
    const children = [
      child({ id: "ses_old", finished: true, created: NOW - 9000 }),
      child({ id: "ses_mid", finished: true, created: NOW - 5000 }),
      child({ id: "ses_new", finished: true, created: NOW - 1000 }),
    ]
    const victim = pickVictim(children, none, new Set(["ses_old"]))
    expect(victim?.child.id).toBe("ses_mid")
    expect(victim?.reason).toBe("finished")
  })

  test("正在被 steer 的子会话也不动", () => {
    const children = [
      child({ id: "ses_old", finished: true, created: NOW - 9000 }),
      child({ id: "ses_mid", finished: true, created: NOW - 5000 }),
    ]
    expect(pickVictim(children, new Set(["ses_old"]), none)?.child.id).toBe("ses_mid")
  })

  test("没有正常已结束的候选时，才兜底淘汰最早的僵尸", () => {
    const children = [
      child({ id: "ses_run", running: true, created: NOW - 20_000 }),
      child({ id: "ses_zombie_late", running: true, stale: true, created: NOW - 9000, busy: NOW - 8000 }),
      child({ id: "ses_zombie_early", running: true, stale: true, created: NOW - 30_000, busy: NOW - 29_000 }),
    ]
    const victim = pickVictim(children, none, none)
    expect(victim?.child.id).toBe("ses_zombie_early")
    expect(victim?.reason).toBe("stale-evict")
  })

  test("有正常已结束的候选时不走僵尸兜底", () => {
    const children = [
      child({ id: "ses_zombie", running: true, stale: true, created: NOW - 30_000, busy: NOW - 29_000 }),
      child({ id: "ses_done", finished: true, created: NOW - 1000 }),
    ]
    const victim = pickVictim(children, none, none)
    expect(victim?.child.id).toBe("ses_done")
    expect(victim?.reason).toBe("finished")
  })

  test("全部运行中（或没有 outcome）时没有候选，调用方据此拒绝", () => {
    const children = [
      child({ id: "ses_r1", running: true }),
      child({ id: "ses_r2", running: true }),
      child({ id: "ses_idle_no_outcome" }),
    ]
    expect(pickVictim(children, none, none)).toBeUndefined()
  })

  test("已结束但仍在跑的不算正常候选", () => {
    const children = [child({ id: "ses_x", finished: true, running: true, created: NOW - 9000 })]
    expect(pickVictim(children, none, none)).toBeUndefined()
  })

  test("保护名单覆盖所有已结束子会话时没有候选", () => {
    const children = [child({ id: "ses_only", finished: true })]
    expect(pickVictim(children, none, new Set(["ses_only"]))).toBeUndefined()
  })
})
const FALLBACK_ENTRIES = [
  { key: "superagent.max-subagents", value: 5 },
  { key: "superagent.fallback-threshold", value: 3 },
  { key: "superagent.fallback-enabled", value: "true" },
  { key: "superagent.fallback-model", value: "zhipuai-coding-plan/glm-5.3" },
  { key: "superagent.subagent-fallback-model", value: "zhipuai-coding-plan/glm-5.3" },
]

function quotaError(message = "429 Too Many Requests") {
  return { type: "provider.rate-limit", message, status: 429 }
}

function fallbackHarness(
  overrides: {
    entries?: any[]
    failSwitch?: boolean
    timeoutMs?: number
    canSwitch?: (input: { sessionID: string; rootID: string }) => Promise<boolean>
    readEntries?: (input: { sessionID: string; rootID: string }) => Promise<any[]>
    /** 切换过程中的钩子：用来制造「切换进行中被打断」的竞态。 */
    onSwitch?: (input: { sessionID: string; model: any }) => void | Promise<void>
  } = {},
) {
  const calls: Array<{ sessionID: string; model: any }> = []
  const writes: Array<{ sessionID: string; limit: number }> = []
  const logs: Array<Record<string, any>> = []
  /** 可推进的假时钟：用来测「到期回调还没排到」的同步路径。 */
  const clock = { value: NOW }
  const controller = createQuotaFallback({
    switchModel: async (input) => {
      if (overrides.onSwitch) await overrides.onSwitch(input)
      if (overrides.failSwitch) throw new Error("switch failed")
      calls.push(input)
    },
    writeLimit: async (input) => {
      writes.push(input)
    },
    log: (record) => logs.push(record),
    now: () => clock.value,
    timeoutMs: overrides.timeoutMs ?? 20,
    canSwitch: overrides.canSwitch,
    readEntries: overrides.readEntries,
  })
  return { controller, calls, writes, logs, clock }
}

/** 等真实定时器：备用切换是计时器驱动的，不经过渲染帧。 */
async function waitFor(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return check()
}

/** 可控 Promise：测试里手动 resolve，用来制造「等待期间被打断」的竞态。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function failTimes(
  controller: ReturnType<typeof createQuotaFallback>,
  times: number,
  input: { sessionID?: string; isRoot?: boolean; error?: unknown; entries?: any[]; model?: any } = {},
) {
  let last: Awaited<ReturnType<typeof controller.onFailure>> = { switched: false }
  for (let index = 0; index < times; index++) {
    last = await controller.onFailure({
      sessionID: input.sessionID ?? "ses_root",
      rootID: "ses_root",
      isRoot: input.isRoot ?? true,
      error: input.error ?? quotaError(),
      model: input.model ?? { providerID: "kimi-code-plan-global", id: "k3.1-pro" },
      entries: input.entries ?? FALLBACK_ENTRIES,
    })
  }
  return last
}

describe("isQuotaFailure", () => {
  test("SessionError 的限额类型与 HTTP 429 都算", () => {
    expect(isQuotaFailure({ type: "provider.rate-limit", message: "slow down" })).toBe(true)
    expect(isQuotaFailure({ type: "provider.quota", message: "no quota" })).toBe(true)
    expect(isQuotaFailure({ type: "unknown", message: "request failed", status: 429 })).toBe(true)
  })

  test("quota / 余额不足文本也算（含响应体）", () => {
    expect(isQuotaFailure({ type: "unknown", message: "You exceeded your current quota" })).toBe(true)
    expect(isQuotaFailure({ type: "unknown", message: "insufficient balance" })).toBe(true)
    expect(
      isQuotaFailure({ type: "unknown", message: "provider rejected", response: { body: '{"error":"insufficient_quota"}' } }),
    ).toBe(true)
  })

  test("超时、网络、内容过滤等非限额错误不算", () => {
    expect(isQuotaFailure({ type: "provider.timeout", message: "Request timed out" })).toBe(false)
    expect(isQuotaFailure({ type: "provider.transport", message: "ECONNRESET" })).toBe(false)
    expect(isQuotaFailure({ type: "provider.content-filter", message: "blocked by policy" })).toBe(false)
    expect(isQuotaFailure({ type: "provider.auth", message: "invalid api key" })).toBe(false)
    expect(isQuotaFailure(new Error("socket hang up"))).toBe(false)
  })

  test("AIError 的 RateLimit tag 也能识别", () => {
    expect(isQuotaFailure({ reason: { _tag: "RateLimit", message: "rate limited" } })).toBe(true)
    expect(isQuotaFailure({ reason: { _tag: "Timeout", message: "timeout" } })).toBe(false)
  })
})

describe("parseModelRef", () => {
  test("providerID/modelID 与 #variant", () => {
    expect(parseModelRef("zhipuai-coding-plan/glm-5.3")).toEqual({
      providerID: "zhipuai-coding-plan",
      id: "glm-5.3",
    })
    expect(parseModelRef("p/m#high")).toEqual({ providerID: "p", id: "m", variant: "high" })
  })

  test("对象与非法值", () => {
    expect(parseModelRef({ providerID: "p", id: "m" })).toEqual({ providerID: "p", id: "m" })
    expect(parseModelRef("")).toBeUndefined()
    expect(parseModelRef("no-slash")).toBeUndefined()
    expect(parseModelRef("/missing-provider")).toBeUndefined()
    expect(parseModelRef(undefined)).toBeUndefined()
  })
})

describe("readFallbackConfig", () => {
  test("读阈值、开关与两个模型", () => {
    const config = readFallbackConfig(FALLBACK_ENTRIES)
    expect(config.enabled).toBe(true)
    expect(config.threshold).toBe(3)
    expect(config.rootModel).toEqual({ providerID: "zhipuai-coding-plan", id: "glm-5.3" })
    expect(config.subModel).toEqual({ providerID: "zhipuai-coding-plan", id: "glm-5.3" })
  })

  test("缺省启用、阈值 3；显式 false 停用；非法阈值回退", () => {
    const defaults = readFallbackConfig([])
    expect(defaults.enabled).toBe(true)
    expect(defaults.threshold).toBe(3)
    expect(defaults.rootModel).toBeUndefined()
    expect(readFallbackConfig([{ key: "superagent.fallback-enabled", value: "false" }]).enabled).toBe(false)
    expect(readFallbackConfig([{ key: "superagent.fallback-threshold", value: "abc" }]).threshold).toBe(3)
    expect(readFallbackConfig([{ key: "superagent.fallback-threshold", value: 0 }]).threshold).toBe(3)
  })
})

describe("downgradeLimit", () => {
  test("5→4→3→2 的阶梯", () => {
    expect(downgradeLimit(5)).toBe(4)
    expect(downgradeLimit(4)).toBe(3)
    expect(downgradeLimit(3)).toBe(2)
  })

  test("下限 2：不再降；非法值不动", () => {
    expect(downgradeLimit(2)).toBeUndefined()
    expect(downgradeLimit(1)).toBeUndefined()
    expect(downgradeLimit(Number.NaN)).toBeUndefined()
    expect(QUOTA_LIMIT_FLOOR).toBe(2)
  })

  test("从条目读上限，缺省 5", () => {
    expect(readMaxSubagents(FALLBACK_ENTRIES)).toBe(5)
    expect(readMaxSubagents([])).toBe(5)
    expect(readMaxSubagents([{ key: "superagent.max-subagents", value: "3" }])).toBe(3)
    expect(readMaxSubagents([{ key: "superagent.max-subagents", value: "nope" }])).toBe(5)
  })
})

describe("denyMessage", () => {
  test("带上当前值/上限/root，并给出可行动指引", () => {
    const message = denyMessage(6, 5, "ses_root")
    expect(message).toContain("当前6/上限5")
    expect(message).toContain("root=ses_root")
    expect(message).toContain("sessionID")
    expect(message).toContain("调大上限")
  })
})

describe("createQuotaFallback", () => {
  test("首次限额失败只开始计时，不切模型", async () => {
    const { controller, calls, logs } = fallbackHarness()
    const result = await failTimes(controller, 1)
    expect(result.switched).toBe(false)
    expect(calls).toHaveLength(0)
    expect(controller.isArmed("ses_root")).toBe(true)
    const armed = logs.find((record) => record.event === "fallback-armed")
    expect(armed?.failures).toBe(1)
    expect(armed?.timeoutMs).toBe(20)
    expect(typeof armed?.deadline).toBe("string")
    controller.dispose()
  })

  test("子会话用 subagent-fallback-model", async () => {
    const entries = [
      ...FALLBACK_ENTRIES,
      { key: "superagent.fallback-model", value: "other/root-model" },
      { key: "superagent.subagent-fallback-model", value: "zhipuai-coding-plan/glm-5.3" },
    ]
    const { controller, calls } = fallbackHarness({ entries })
    await failTimes(controller, 1, { sessionID: "ses_child", isRoot: false, entries })
    expect(await waitFor(() => calls.length === 1)).toBe(true)
    expect(calls[0].model).toEqual({ providerID: "zhipuai-coding-plan", id: "glm-5.3" })
    controller.dispose()
  })

  test("窗口到期仍未恢复：切一次备用模型并把上限降一档", async () => {
    const { controller, calls, writes, logs } = fallbackHarness()
    await failTimes(controller, 1)
    expect(calls).toHaveLength(0)
    expect(await waitFor(() => calls.length === 1)).toBe(true)
    expect(calls[0].sessionID).toBe("ses_root")
    expect(calls[0].model).toEqual({ providerID: "zhipuai-coding-plan", id: "glm-5.3" })
    const switched = logs.find((record) => record.event === "fallback-model-switch")
    expect(switched?.reason).toBe("timeout")
    expect(writes).toEqual([{ sessionID: "ses_root", limit: 4 }])
    const tierDown = logs.find((record) => record.event === "quota-tier-down")
    expect(tierDown?.from).toBe(5)
    expect(tierDown?.to).toBe(4)
    expect(tierDown?.root).toBe("ses_root")
    expect(controller.hasSwitched("ses_root")).toBe(true)
    controller.dispose()
  })

  test("窗口内成功恢复（reset）：取消计时，不切模型", async () => {
    const { controller, calls } = fallbackHarness()
    await failTimes(controller, 2)
    controller.reset("ses_root")
    expect(controller.isArmed("ses_root")).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(calls).toHaveLength(0)
    expect(controller.failuresOf("ses_root")).toBe(0)
    controller.dispose()
  })

  test("超时前连续多次失败：不重复计时，也不提前切", async () => {
    const { controller, calls, logs } = fallbackHarness()
    await failTimes(controller, 3)
    expect(calls).toHaveLength(0)
    expect(logs.filter((record) => record.event === "fallback-armed")).toHaveLength(1)
    expect(await waitFor(() => calls.length === 1)).toBe(true)
    expect(calls).toHaveLength(1)
    controller.dispose()
  })

  test("切换失败：再重试一次，两次之后放弃", async () => {
    const { controller, calls, logs } = fallbackHarness({ failSwitch: true })
    await failTimes(controller, 1)
    expect(await waitFor(() => logs.some((record) => record.event === "fallback-retry-armed"))).toBe(true)
    expect(await waitFor(() => logs.some((record) => record.event === "fallback-timeout-giveup"))).toBe(true)
    expect(logs.filter((record) => record.event === "fallback-switch-failed")).toHaveLength(2)
    expect(calls).toHaveLength(0)
    expect(controller.hasSwitched("ses_root")).toBe(false)
    expect(controller.isArmed("ses_root")).toBe(false)
    controller.dispose()
  })

  test("到点时不允许切换（协作停用或受保护）：不切模型", async () => {
    const { controller, calls, logs } = fallbackHarness({ canSwitch: async () => false })
    await failTimes(controller, 1)
    expect(await waitFor(() => logs.some((record) => record.event === "fallback-timeout-skip"))).toBe(true)
    expect(calls).toHaveLength(0)
    expect(controller.isArmed("ses_root")).toBe(false)
    controller.dispose()
  })

  test("到点时读到停用配置：不切模型", async () => {
    const { controller, calls, logs } = fallbackHarness({
      readEntries: async () => [{ key: "superagent.fallback-enabled", value: "false" }],
    })
    await failTimes(controller, 1)
    expect(await waitFor(() => logs.some((record) => record.event === "fallback-disabled"))).toBe(true)
    expect(calls).toHaveLength(0)
    controller.dispose()
  })

  test("到点时读配置失败：沿用首次快照照常切换", async () => {
    const { controller, calls, logs } = fallbackHarness({
      readEntries: async () => {
        throw new Error("instructions down")
      },
    })
    await failTimes(controller, 1)
    expect(await waitFor(() => calls.length === 1)).toBe(true)
    expect(logs.some((record) => record.event === "fallback-entries-read-failed")).toBe(true)
    controller.dispose()
  })

  test("目标与当前模型相同：不切并标记已切", async () => {
    const { controller, calls, logs } = fallbackHarness()
    await failTimes(controller, 1, { model: { providerID: "zhipuai-coding-plan", id: "glm-5.3" } })
    expect(await waitFor(() => logs.some((record) => record.event === "fallback-same-model"))).toBe(true)
    expect(calls).toHaveLength(0)
    expect(controller.hasSwitched("ses_root")).toBe(true)
    controller.dispose()
  })

  test("每个会话只自动切一次：已切过再失败不回切", async () => {
    const { controller, calls, logs } = fallbackHarness()
    await failTimes(controller, 1)
    expect(await waitFor(() => calls.length === 1)).toBe(true)
    await failTimes(controller, 1)
    expect(calls).toHaveLength(1)
    expect(logs.some((record) => record.event === "fallback-already-switched")).toBe(true)
    controller.dispose()
  })

  test("非限额错误：不计时", async () => {
    const { controller, calls } = fallbackHarness()
    await failTimes(controller, 3, { error: { type: "provider.timeout", message: "timed out" } })
    expect(controller.failuresOf("ses_root")).toBe(0)
    expect(controller.isArmed("ses_root")).toBe(false)
    expect(calls).toHaveLength(0)
    controller.dispose()
  })

  test("停用或未配置对应模型时不计时", async () => {
    const disabledEntries = [
      { key: "superagent.fallback-enabled", value: "false" },
      { key: "superagent.fallback-model", value: "p/m" },
    ]
    const disabled = fallbackHarness({ entries: disabledEntries })
    await failTimes(disabled.controller, 5, { entries: disabledEntries })
    expect(disabled.calls).toHaveLength(0)
    expect(disabled.controller.isArmed("ses_root")).toBe(false)

    const unconfigured = fallbackHarness({ entries: [] })
    await failTimes(unconfigured.controller, 5, { entries: [] })
    expect(unconfigured.calls).toHaveLength(0)
    expect(unconfigured.logs.some((record) => record.event === "fallback-unconfigured")).toBe(true)
    expect(unconfigured.controller.isArmed("ses_root")).toBe(false)
    disabled.controller.dispose()
    unconfigured.controller.dispose()
  })

  test("上限已到 2 时不再降档", async () => {
    const entries = [
      ...FALLBACK_ENTRIES.filter((entry) => entry.key !== "superagent.max-subagents"),
      { key: "superagent.max-subagents", value: 2 },
    ]
    const { controller, writes, logs } = fallbackHarness({ entries })
    await failTimes(controller, 1, { entries })
    expect(await waitFor(() => logs.some((record) => record.event === "quota-tier-down-skip"))).toBe(true)
    expect(writes).toHaveLength(0)
    controller.dispose()
  })

  test("计时已到期但回调还没排到：当场同步切换", async () => {
    const { controller, calls, clock } = fallbackHarness()
    await failTimes(controller, 1)
    clock.value = NOW + 60_000
    const result = await failTimes(controller, 1)
    expect(result.switched).toBe(true)
    expect(result.to).toEqual({ providerID: "zhipuai-coding-plan", id: "glm-5.3" })
    expect(calls).toHaveLength(1)
    controller.dispose()
  })

  test("dispose 之后计时不再触发切换", async () => {
    const { controller, calls } = fallbackHarness()
    await failTimes(controller, 1)
    controller.dispose()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(calls).toHaveLength(0)
  })

  test("等待 canSwitch 期间被 reset：不再切模型", async () => {
    const gate = deferred<boolean>()
    const { controller, calls } = fallbackHarness({ canSwitch: async () => gate.promise })
    await failTimes(controller, 1)
    // 到点后停在 canSwitch 上。
    await new Promise((resolve) => setTimeout(resolve, 40))
    controller.reset("ses_root")
    gate.resolve(true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(calls).toHaveLength(0)
    expect(controller.isArmed("ses_root")).toBe(false)
    controller.dispose()
  })

  test("等待 readEntries 期间被 reset：不再切模型", async () => {
    const gate = deferred<any[]>()
    const { controller, calls } = fallbackHarness({ readEntries: async () => gate.promise })
    await failTimes(controller, 1)
    await new Promise((resolve) => setTimeout(resolve, 40))
    controller.reset("ses_root")
    gate.resolve(FALLBACK_ENTRIES)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(calls).toHaveLength(0)
    expect(controller.isArmed("ses_root")).toBe(false)
    controller.dispose()
  })

  test("切换进行中被 dispose：不再重试计时，也不抛", async () => {
    let controllerRef: ReturnType<typeof createQuotaFallback> | undefined
    const { controller, calls, logs } = fallbackHarness({
      failSwitch: true,
      onSwitch: async () => {
        // 切换过程中插件被卸载。
        controllerRef?.dispose()
      },
    })
    controllerRef = controller
    await failTimes(controller, 1)
    await new Promise((resolve) => setTimeout(resolve, 120))
    // 只记一条切换失败，不再有重试计时，也不会有第二次切换。
    expect(logs.filter((record) => record.event === "fallback-switch-failed")).toHaveLength(1)
    expect(logs.some((record) => record.event === "fallback-retry-armed")).toBe(false)
    expect(calls).toHaveLength(0)
    expect(controller.isArmed("ses_root")).toBe(false)
  })

  test("dispose 之后再来限额失败：不再起计时", async () => {
    const { controller, calls } = fallbackHarness()
    controller.dispose()
    await failTimes(controller, 1)
    expect(controller.isArmed("ses_root")).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(calls).toHaveLength(0)
  })
})

describe("限额切换实测（fake 会话）", () => {
  test("首次限额失败后到点：fake 会话的模型变成 glm-5.3", async () => {
    const session = {
      sessionID: "ses_root",
      model: { providerID: "kimi-code-plan-global", id: "k3.1-pro" },
    }
    const logs: Array<Record<string, any>> = []
    const controller = createQuotaFallback({
      switchModel: async ({ model }) => {
        session.model = model
      },
      writeLimit: async () => {},
      log: (record) => logs.push(record),
      now: () => NOW,
      timeoutMs: 20,
    })
    await controller.onFailure({
      sessionID: "ses_root",
      rootID: "ses_root",
      isRoot: true,
      error: quotaError(),
      model: session.model,
      entries: FALLBACK_ENTRIES,
      attempt: 1,
    })
    expect(`${session.model.providerID}/${session.model.id}`).toBe("kimi-code-plan-global/k3.1-pro")
    expect(await waitFor(() => `${session.model.providerID}/${session.model.id}` === "zhipuai-coding-plan/glm-5.3")).toBe(true)
    const switched = logs.find((record) => record.event === "fallback-model-switch")
    expect(switched?.from).toBe("kimi-code-plan-global/k3.1-pro")
    expect(switched?.to).toBe("zhipuai-coding-plan/glm-5.3")
    expect(switched?.reason).toBe("timeout")
    controller.dispose()
  })
})

describe("forceRetryAfterSwitch", () => {
  test("切换成功后把不重试的决策翻成继续重试", () => {
    const event: any = { decision: { retry: false } }
    expect(forceRetryAfterSwitch(event, true)).toBe(true)
    expect(event.decision).toEqual({ retry: true, delay: FALLBACK_RETRY_DELAY_MS })
  })

  test("没切换（或事件没有决策）时保持 core 原决策", () => {
    const event: any = { decision: { retry: true, delay: 5000 } }
    expect(forceRetryAfterSwitch(event, false)).toBe(false)
    expect(event.decision).toEqual({ retry: true, delay: 5000 })
    expect(forceRetryAfterSwitch({}, true)).toBe(false)
  })
})

describe("critic 触发判定", () => {
  const enabled = [{ key: "superagent.critic-enabled", value: "true" }]
  const base = {
    eventType: "session.execution.succeeded",
    childSessionID: "ses_child",
    rootID: "ses_root",
    child: { title: "修复登录" },
    entries: enabled,
  }

  test("开关解析：布尔、字符串与数字都认，缺省关闭", () => {
    expect(isEnabledValue(true)).toBe(true)
    for (const value of ["true", "TRUE", "1", "on", "yes"]) expect(isEnabledValue(value)).toBe(true)
    for (const value of [false, "false", "0", "off", "no", "", 0, undefined, null]) {
      expect(isEnabledValue(value)).toBe(false)
    }
    expect(readCriticEnabled([])).toBe(false)
    expect(readCriticEnabled([{ key: "superagent.critic-enabled", value: "false" }])).toBe(false)
    expect(readCriticEnabled(enabled)).toBe(true)
  })

  test("只有成功完成的非 root 子会话才复核", () => {
    expect(shouldCriticReview(base)).toBe(true)
    expect(shouldCriticReview({ ...base, eventType: "session.execution.failed" })).toBe(false)
    expect(shouldCriticReview({ ...base, childSessionID: "ses_root" })).toBe(false)
    expect(shouldCriticReview({ ...base, entries: [] })).toBe(false)
    expect(shouldCriticReview({ ...base, entries: [{ key: "superagent.critic-enabled", value: "false" }] })).toBe(false)
  })

  test("critic 会话不递归复核：标题前缀与 metadata 标记都算", () => {
    expect(shouldCriticReview({ ...base, child: { title: `${CRITIC_TITLE_PREFIX}修复登录` } })).toBe(false)
    expect(shouldCriticReview({ ...base, child: { title: "[critic] 修复登录" } })).toBe(false)
    expect(shouldCriticReview({ ...base, child: { metadata: { "superagent.critic": true } } })).toBe(false)
  })

  test("同一子会话已有复核在跑时跳过", () => {
    expect(shouldCriticReview({ ...base, inFlight: new Set(["ses_child"]) })).toBe(false)
    expect(shouldCriticReview({ ...base, inFlight: new Set(["ses_other"]) })).toBe(true)
  })
})

describe("超时探针判定", () => {
  const busyAt = (age: number): ProbeCandidate => ({ id: "ses_child", busy: NOW - age })

  test("阈值 30 分钟，满阈值即探，差 1ms 不探", () => {
    expect(PROBE_AFTER_MS).toBe(30 * 60 * 1000)
    expect(shouldProbe(busyAt(PROBE_AFTER_MS), NOW, new Set())).toBe(true)
    expect(shouldProbe(busyAt(PROBE_AFTER_MS - 1), NOW, new Set())).toBe(false)
  })

  test("没有开工、已有 idle、已有 outcome 或已探过都不探", () => {
    expect(shouldProbe({ id: "ses_child" }, NOW, new Set())).toBe(false)
    expect(shouldProbe({ ...busyAt(PROBE_AFTER_MS), idle: NOW - 1000 }, NOW, new Set())).toBe(false)
    expect(shouldProbe({ ...busyAt(PROBE_AFTER_MS), outcome: "succeeded" }, NOW, new Set())).toBe(false)
    expect(shouldProbe({ ...busyAt(PROBE_AFTER_MS), outcome: "failed" }, NOW, new Set())).toBe(false)
    expect(shouldProbe(busyAt(PROBE_AFTER_MS), NOW, new Set(["ses_child"]))).toBe(false)
  })

  test("critic 会话不探：标题前缀与 metadata 标记都算", () => {
    expect(shouldProbe({ ...busyAt(PROBE_AFTER_MS), title: `${CRITIC_TITLE_PREFIX}x` }, NOW, new Set())).toBe(false)
    expect(
      shouldProbe({ ...busyAt(PROBE_AFTER_MS), metadata: { "superagent.critic": true } }, NOW, new Set()),
    ).toBe(false)
  })

  test("会话列表项 → 候选：只取 time 里的 busy/idle", () => {
    const candidate = toProbeCandidate({
      id: "ses_child",
      title: "任务",
      outcome: null,
      time: { busy: NOW - 500, idle: NOW - 100 },
      metadata: { k: 1 },
    })
    expect(candidate).toEqual({
      id: "ses_child",
      title: "任务",
      outcome: null,
      busy: NOW - 500,
      idle: NOW - 100,
      metadata: { k: 1 },
    })
    expect(toProbeCandidate({ time: { busy: "nope" } }).busy).toBeUndefined()
  })
})

describe("createProbeScanner", () => {
  function harness(
    candidates: ProbeCandidate[],
    options: { failScan?: boolean; failSend?: boolean; failConfig?: boolean; configured?: boolean; claim?: boolean } = {},
  ) {
    const sent: Array<{ sessionID: string; text: string }> = []
    const logs: Array<Record<string, unknown>> = []
    const scanner = createProbeScanner({
      listSessions: async () => {
        if (options.failScan) throw new Error("scan down")
        return candidates
      },
      resolveRoot: async (sessionID) => (sessionID === "ses_root" ? "ses_root" : "ses_root"),
      rootIsConfigured: async () => {
        if (options.failConfig) throw new Error("config down")
        return options.configured ?? true
      },
      sendProbe: async (sessionID, text) => {
        if (options.failSend) throw new Error("send down")
        sent.push({ sessionID, text })
      },
      claim: () => options.claim ?? true,
      log: (record) => logs.push(record),
      now: () => NOW,
    })
    return { scanner, sent, logs }
  }

  const longRunning: ProbeCandidate = { id: "ses_child", busy: NOW - PROBE_AFTER_MS - 1000 }

  test("扫描到超时会话时发 steer 探针，每会话只发一次", async () => {
    const { scanner, sent, logs } = harness([longRunning])
    expect(await scanner.scan()).toBe(1)
    expect(sent).toEqual([{ sessionID: "ses_child", text: PROBE_TEXT }])
    expect(logs.some((record) => record.event === "probe-sent" && record.sessionID === "ses_child")).toBe(true)

    expect(await scanner.scan()).toBe(0)
    expect(sent).toHaveLength(1)
  })

  test("发送失败也记入已探集合，下一轮不再重试", async () => {
    const { scanner, sent, logs } = harness([longRunning], { failSend: true })
    expect(await scanner.scan()).toBe(0)
    expect(sent).toHaveLength(0)
    expect(logs.some((record) => record.event === "probe-failed")).toBe(true)
    expect(await scanner.scan()).toBe(0)
    expect(logs.filter((record) => record.event === "probe-failed")).toHaveLength(1)
  })

  test("没到阈值、已结束与 critic 会话都不发", async () => {
    const { scanner, sent } = harness([
      { id: "ses_young", busy: NOW - 1000 },
      { id: "ses_done", busy: NOW - PROBE_AFTER_MS - 1000, outcome: "succeeded" },
      { id: "ses_critic", busy: NOW - PROBE_AFTER_MS - 1000, title: `${CRITIC_TITLE_PREFIX}x` },
    ])
    expect(await scanner.scan()).toBe(0)
    expect(sent).toHaveLength(0)
  })

  test("root 自己、未开 superagent 配置的家族不探", async () => {
    const rootItself = harness([{ id: "ses_root", busy: NOW - PROBE_AFTER_MS - 1000 }])
    expect(await rootItself.scanner.scan()).toBe(0)

    const unmanaged = harness([longRunning], { configured: false })
    expect(await unmanaged.scanner.scan()).toBe(0)
    expect(unmanaged.sent).toHaveLength(0)
  })

  test("别的实例已声明时本实例不发", async () => {
    const { scanner, sent } = harness([longRunning], { claim: false })
    expect(await scanner.scan()).toBe(0)
    expect(sent).toHaveLength(0)
  })

  test("列表失败只记日志，不抛出", async () => {
    const down = harness([], { failScan: true })
    expect(await down.scanner.scan()).toBe(0)
    expect(down.logs.some((record) => record.event === "probe-scan-failed")).toBe(true)
  })

  test("解析 root 或读配置失败时跳过本会话，下一轮还会重试", async () => {
    const logs: Array<Record<string, unknown>> = []
    let configCalls = 0
    const scanner = createProbeScanner({
      listSessions: async () => [longRunning],
      resolveRoot: async () => {
        throw new Error("root down")
      },
      rootIsConfigured: async () => {
        configCalls++
        return true
      },
      sendProbe: async () => {},
      log: (record) => logs.push(record),
      now: () => NOW,
    })
    expect(await scanner.scan()).toBe(0)
    expect(configCalls).toBe(0)
    expect(logs.some((record) => record.event === "probe-root-failed")).toBe(true)

    const configLogs: Array<Record<string, unknown>> = []
    let calls = 0
    const failingConfig = createProbeScanner({
      listSessions: async () => [longRunning],
      resolveRoot: async () => "ses_root",
      rootIsConfigured: async () => {
        calls++
        throw new Error("config down")
      },
      sendProbe: async () => {},
      log: (record) => configLogs.push(record),
      now: () => NOW,
    })
    expect(await failingConfig.scan()).toBe(0)
    expect(configLogs.some((record) => record.event === "probe-config-failed")).toBe(true)
    // 配置没读到就不缓存，下一轮重试。
    expect(await failingConfig.scan()).toBe(0)
    expect(calls).toBe(2)
  })
})

describe("startProbeTimer", () => {
  test("按间隔扫描，stop 时清理定时器", async () => {
    let handler: (() => void) | undefined
    let cleared: unknown
    let scans = 0
    const timer = startProbeTimer(
      async () => {
        scans++
      },
      {
        intervalMs: 1234,
        setIntervalFn: (fn) => {
          handler = fn
          return "handle-1"
        },
        clearIntervalFn: (handle) => {
          cleared = handle
        },
      },
    )
    expect(timer.intervalMs).toBe(1234)
    expect(PROBE_INTERVAL_MS).toBe(5 * 60 * 1000)
    handler!()
    await Promise.resolve()
    expect(scans).toBe(1)
    timer.stop()
    expect(cleared).toBe("handle-1")
  })
})

describe("claimCriticReview", () => {
  test("同一事件 ID 只有一个实例拿到复核权", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "critic-claim-"))
    try {
      expect(claimCriticReview("evt_123", dir)).toBe(true)
      expect(claimCriticReview("evt_123", dir)).toBe(false)
      // 不同完成事件互不影响。
      expect(claimCriticReview("evt_456", dir)).toBe(true)
      // 没有事件 ID 时不去重（实例内守卫兜底）。
      expect(claimCriticReview(undefined, dir)).toBe(true)
      expect(claimCriticReview("", dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("非法字符不会逃出声明目录", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "critic-claim-"))
    try {
      expect(claimCriticReview("../../escape", dir)).toBe(true)
      expect(claimCriticReview("../../escape", dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("探针声明按 sessionID 去重", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "probe-claim-"))
    try {
      expect(claimProbe("ses_child", dir)).toBe(true)
      expect(claimProbe("ses_child", dir)).toBe(false)
      expect(claimProbe("ses_other", dir)).toBe(true)
      expect(claimProbe(undefined, dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
