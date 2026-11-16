/**
 * 收尾淘汰纯逻辑：全假依赖驱动，覆盖上限判断、候选筛选与并发/失败分支。
 */
import { describe, expect, test } from "bun:test"

import type { Child } from "./server-state"
import { createCompletionEvictor, type EvictVerdict } from "./subagent-evict"

const ROOT = "ses_root"

function child(id: string, created: number, overrides: Partial<Child> = {}): Child {
  return { id, created, running: false, finished: true, stale: false, ...overrides }
}

function makeHarness(init: {
  children: Child[]
  limit?: number
  kept?: Set<string> | "fail"
  steered?: string[]
  inflight?: number
  enabled?: boolean
  remove?: (id: string, store: { children: Child[]; removed: string[] }) => Promise<void> | void
  classify?: (rootID: string, victimID: string) => Promise<EvictVerdict>
}) {
  const store = { children: [...init.children], removed: [] as string[] }
  const logs: Record<string, any>[] = []
  const keptCalls: number[] = []
  const evictor = createCompletionEvictor({
    listChildren: async () => [...store.children],
    readLimit: async () => init.limit ?? 5,
    readKept: async () => {
      keptCalls.push(Date.now())
      if (init.kept === "fail") return undefined
      return init.kept ? new Set(init.kept) : new Set<string>()
    },
    remove: async (sessionID) => {
      store.removed.push(sessionID)
      if (init.remove) {
        await init.remove(sessionID, store)
        return
      }
      store.children = store.children.filter((item) => item.id !== sessionID)
    },
    classify: init.classify ?? (async () => ({ status: "real" as const })),
    isSteered: (sessionID) => (init.steered ?? []).includes(sessionID),
    inflight: init.inflight === undefined ? undefined : () => init.inflight as number,
    enabled: init.enabled === undefined ? undefined : async () => init.enabled as boolean,
    now: () => 1_000,
    log: (event) => logs.push(event),
  })
  return { evictor, store, logs, keptCalls }
}

describe("收尾淘汰", () => {
  test("未超限不删：exist=limit 时不动数据也不写日志", async () => {
    const { evictor, store, logs, keptCalls } = makeHarness({
      children: [child("ses_1", 1), child("ses_2", 2), child("ses_3", 3), child("ses_4", 4), child("ses_5", 5)],
    })
    await evictor.evictExcess(ROOT)
    expect(store.removed).toEqual([])
    expect(logs).toEqual([])
    expect(keptCalls).toHaveLength(0)
  })

  test("6/5 删最旧的已完成，保留最新", async () => {
    const { evictor, store, logs } = makeHarness({
      children: [child("ses_3", 3), child("ses_1", 1), child("ses_6", 6), child("ses_2", 2), child("ses_5", 5), child("ses_4", 4)],
    })
    await evictor.evictExcess(ROOT)
    expect(store.removed).toEqual(["ses_1"])
    expect(store.children.map((item) => item.id)).toEqual(["ses_3", "ses_6", "ses_2", "ses_5", "ses_4"])
    const evicted = logs.filter((event) => event.event === "subagent-evict")
    expect(evicted).toHaveLength(1)
    expect(evicted[0]).toMatchObject({
      decision: "allow",
      trigger: "completion",
      reason: "finished",
      root: ROOT,
      victim: "ses_1",
      exist: 6,
      inflight: 0,
      count: 6,
      limit: 5,
      evicted: 1,
    })
  })

  test("kept 跳过并继续删下一个最旧", async () => {
    const { evictor, store } = makeHarness({
      children: [child("ses_1", 1), child("ses_2", 2), child("ses_3", 3), child("ses_4", 4), child("ses_5", 5), child("ses_6", 6)],
      kept: new Set(["ses_1"]),
    })
    await evictor.evictExcess(ROOT)
    expect(store.removed).toEqual(["ses_2"])
  })

  test("steered 跳过并继续删下一个最旧", async () => {
    const { evictor, store } = makeHarness({
      children: [child("ses_1", 1), child("ses_2", 2), child("ses_3", 3), child("ses_4", 4), child("ses_5", 5), child("ses_6", 6)],
      steered: ["ses_1"],
    })
    await evictor.evictExcess(ROOT)
    expect(store.removed).toEqual(["ses_2"])
  })

  test("running 跳过，即使已跑到终态", async () => {
    const { evictor, store } = makeHarness({
      children: [
        child("ses_1", 1, { running: true }),
        child("ses_2", 2),
        child("ses_3", 3),
        child("ses_4", 4),
        child("ses_5", 5),
        child("ses_6", 6),
      ],
    })
    await evictor.evictExcess(ROOT)
    expect(store.removed).toEqual(["ses_2"])
  })

  test("stale 不淘汰，记 evict-blocked", async () => {
    const { evictor, store, logs } = makeHarness({
      children: [
        child("ses_1", 1, { finished: false, stale: true }),
        child("ses_2", 2, { finished: false, stale: true }),
        child("ses_3", 3, { finished: false, stale: true }),
        child("ses_4", 4, { finished: false, stale: true }),
        child("ses_5", 5, { finished: false, stale: true }),
        child("ses_6", 6, { finished: false, stale: true }),
      ],
    })
    await evictor.evictExcess(ROOT)
    expect(store.removed).toEqual([])
    expect(logs).toEqual([
      { event: "evict-blocked", trigger: "completion", root: ROOT, exist: 6, inflight: 0, count: 6, limit: 5 },
    ])
  })

  test("在途计入总额：exist=4 + inflight=2 / limit=5 只删 1 个", async () => {
    const { evictor, store, logs } = makeHarness({
      children: [child("ses_1", 1), child("ses_2", 2), child("ses_3", 3), child("ses_4", 4)],
      inflight: 2,
    })
    await evictor.evictExcess(ROOT)
    expect(store.removed).toEqual(["ses_1"])
    expect(store.children).toHaveLength(3)
    const evicted = logs.filter((event) => event.event === "subagent-evict")
    expect(evicted[0]).toMatchObject({ exist: 4, inflight: 2, count: 6, limit: 5 })
  })

  test("删除报并发移除时继续，最终回到上限内", async () => {
    const { evictor, store, logs } = makeHarness({
      children: [
        child("ses_1", 1),
        child("ses_2", 2),
        child("ses_3", 3),
        child("ses_4", 4),
        child("ses_5", 5),
        child("ses_6", 6),
        child("ses_7", 7),
      ],
      // 模拟并发请求先删掉了 victim：本地 remove 看到 NotFound，但数据已经没了。
      remove: async (sessionID, state) => {
        state.children = state.children.filter((item) => item.id !== sessionID)
        if (sessionID === "ses_1") throw new Error("session not found")
      },
      classify: async () => ({ status: "concurrent", children: [] }),
    })
    await evictor.evictExcess(ROOT)
    expect(store.removed).toEqual(["ses_1", "ses_2"])
    expect(store.children).toHaveLength(5)
    expect(logs.some((event) => event.event === "evict-concurrent")).toBe(true)
    expect(logs.some((event) => event.event === "evict-failed")).toBe(false)
  })

  test("真实删除失败记 evict-failed 且不抛异常", async () => {
    const { evictor, store, logs } = makeHarness({
      children: [child("ses_1", 1), child("ses_2", 2), child("ses_3", 3), child("ses_4", 4), child("ses_5", 5), child("ses_6", 6)],
      remove: async () => {
        throw new Error("boom")
      },
    })
    await evictor.evictExcess(ROOT)
    expect(store.removed).toEqual(["ses_1"])
    expect(store.children).toHaveLength(6)
    const failed = logs.filter((event) => event.event === "evict-failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ decision: "error", trigger: "completion", root: ROOT, victim: "ses_1" })
    expect(logs.some((event) => event.event === "subagent-evict")).toBe(false)
  })

  test("同一 root 并发触发单飞：只做最小必要删除", async () => {
    const { evictor, store } = makeHarness({
      children: [
        child("ses_1", 1),
        child("ses_2", 2),
        child("ses_3", 3),
        child("ses_4", 4),
        child("ses_5", 5),
        child("ses_6", 6),
        child("ses_7", 7),
        child("ses_8", 8),
      ],
    })
    const first = evictor.evictExcess(ROOT)
    const second = evictor.evictExcess(ROOT)
    await Promise.all([first, second])
    expect(store.removed).toEqual(["ses_1", "ses_2", "ses_3"])
    expect(store.children).toHaveLength(5)
  })

  test("保护名单读失败不删，记 evict-skip", async () => {
    const { evictor, store, logs } = makeHarness({
      children: [child("ses_1", 1), child("ses_2", 2), child("ses_3", 3), child("ses_4", 4), child("ses_5", 5), child("ses_6", 6)],
      kept: "fail",
    })
    await evictor.evictExcess(ROOT)
    expect(store.removed).toEqual([])
    expect(logs).toEqual([
      { event: "evict-skip", trigger: "completion", root: ROOT, reason: "kept-read-failed" },
    ])
  })

  test("enabled=false 不删也不写日志", async () => {
    const { evictor, store, logs, keptCalls } = makeHarness({
      children: [child("ses_1", 1), child("ses_2", 2), child("ses_3", 3), child("ses_4", 4), child("ses_5", 5), child("ses_6", 6)],
      enabled: false,
    })
    await evictor.evictExcess(ROOT)
    expect(store.removed).toEqual([])
    expect(keptCalls).toHaveLength(0)
    expect(logs).toEqual([])
  })
})