/** 扫描器回归：卸载边界、活跃判定与忙碌周期去重（B3）、配置缓存 TTL（B2）。 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createCtxCompactionScanner, createProbeScanner, shouldProbe } from "./server-scanners"
import { PROBE_AFTER_MS } from "./server-state"
import { CRITIC_TITLE_PREFIX } from "./critic"

const cleanups: string[] = []

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
  delete process.env.SUPERAGENT_STATE_DIR
})

function stateDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "superagent-scanner-abort-"))
  cleanups.push(dir)
  process.env.SUPERAGENT_STATE_DIR = dir
}

function gate<T>(value: T) {
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    async read() {
      started()
      await waiting
      return value
    },
  }
}

const candidate = {
  id: "ses_child",
  parentID: "ses_root",
  busy: 1,
  outcome: null,
}

const scannerDeps = {
  resolveRoot: async () => "ses_root",
  rootIsConfigured: async () => true,
  rootIsEnabled: async () => true,
  log: () => {},
}

const NOW = 1_800_000_000_000

describe("scanner dispose races", () => {
  test("probe scan aborted while listing does not send a late probe", async () => {
    stateDir()
    const controller = new AbortController()
    const listed = gate([candidate])
    const sent: string[] = []
    const scanner = createProbeScanner({
      ...scannerDeps,
      listSessions: listed.read,
      sendProbe: async (sessionID) => {
        sent.push(sessionID)
      },
      claim: () => true,
      signal: controller.signal,
    })
    const scan = scanner.scan()
    await listed.entered
    controller.abort()
    listed.release()
    expect(await scan).toBe(0)
    expect(sent).toEqual([])
  })

  test("context scan aborted while listing does not compact late", async () => {
    stateDir()
    const controller = new AbortController()
    const listed = gate([candidate])
    const compacted: string[] = []
    const scanner = createCtxCompactionScanner({
      ...scannerDeps,
      listSessions: listed.read,
      readTokens: async () => 350_000,
      compactSession: async (sessionID) => {
        compacted.push(sessionID)
      },
      claim: () => true,
      signal: controller.signal,
    })
    const scan = scanner.scan()
    await listed.entered
    controller.abort()
    listed.release()
    expect(await scan).toBe(0)
    expect(compacted).toEqual([])
  })
})

describe("B3 shouldProbe：活跃优先于残留 outcome，按忙碌周期去重", () => {
  const busyAt = (age: number, extra: Record<string, unknown> = {}) => ({
    id: "ses_child",
    busy: NOW - age,
    ...extra,
  })

  test("残留 idle（早于 busy）与残留 outcome 不再排除", () => {
    expect(shouldProbe(busyAt(PROBE_AFTER_MS, { idle: NOW - PROBE_AFTER_MS - 5000 }), NOW, new Map())).toBe(true)
    expect(shouldProbe(busyAt(PROBE_AFTER_MS, { outcome: "succeeded" }), NOW, new Map())).toBe(true)
    expect(shouldProbe(busyAt(PROBE_AFTER_MS, { outcome: "failed", idle: NOW - PROBE_AFTER_MS - 1 }), NOW, new Map())).toBe(true)
  })

  test("回合已结束（idle 不早于 busy）与无 busy 的不探", () => {
    expect(shouldProbe(busyAt(PROBE_AFTER_MS, { idle: NOW - 1000 }), NOW, new Map())).toBe(false)
    expect(shouldProbe(busyAt(PROBE_AFTER_MS, { idle: NOW - PROBE_AFTER_MS }), NOW, new Map())).toBe(false)
    expect(shouldProbe({ id: "ses_child" }, NOW, new Map())).toBe(false)
  })

  test("同一忙碌周期不重复探，新忙碌周期可再探", () => {
    // 已探的是更早的忙碌周期；当前 busy 不同且同样满阈值才允许再探。
    const probed = new Map<string, number>([["ses_child", NOW - PROBE_AFTER_MS - 5000]])
    expect(shouldProbe(busyAt(PROBE_AFTER_MS), NOW, probed)).toBe(true)
    expect(shouldProbe(busyAt(PROBE_AFTER_MS - 1), NOW, probed)).toBe(false)
    const same = new Map<string, number>([["ses_child", NOW - PROBE_AFTER_MS]])
    expect(shouldProbe(busyAt(PROBE_AFTER_MS), NOW, same)).toBe(false)
  })

  test("旧式只记 sessionID 的集合按已探处理；critic 只认 metadata 标记", () => {
    expect(shouldProbe(busyAt(PROBE_AFTER_MS), NOW, new Set(["ses_child"]) as any)).toBe(false)
    // critic 身份只认 metadata["superagent.critic"] === true，标题像复核的普通会话仍要探。
    expect(shouldProbe(busyAt(PROBE_AFTER_MS, { title: `${CRITIC_TITLE_PREFIX}x` }), NOW, new Map())).toBe(true)
    expect(shouldProbe(busyAt(PROBE_AFTER_MS, { metadata: { "superagent.critic": true } }), NOW, new Map())).toBe(false)
  })
})

describe("B3 扫描器：每个忙碌周期探一次", () => {
  test("残留 outcome 的会话可被探，同周期不重探，新周期再探", async () => {
    stateDir()
    const sent: string[] = []
    let busy = NOW - PROBE_AFTER_MS - 1000
    const scanner = createProbeScanner({
      listSessions: async () => [{ id: "ses_child", busy, idle: busy - 500, outcome: "failed" }],
      resolveRoot: async () => "ses_root",
      rootIsConfigured: async () => true,
      rootIsEnabled: async () => true,
      sendProbe: async (sessionID) => {
        sent.push(sessionID)
      },
      claim: () => true,
      log: () => {},
      now: () => NOW,
    })
    expect(await scanner.scan()).toBe(1)
    expect(await scanner.scan()).toBe(0)
    busy = NOW - PROBE_AFTER_MS - 2000
    expect(await scanner.scan()).toBe(1)
    expect(sent).toEqual(["ses_child", "ses_child"])
  })
})

describe("B2 配置缓存 TTL", () => {
  test("root 初始未配置；写入后推进假时钟超过 TTL，下一拍识别为已配置", async () => {
    stateDir()
    let clock = NOW
    let managed = false
    const sent: string[] = []
    const scanner = createProbeScanner({
      listSessions: async () => [{ id: "ses_child", busy: clock - PROBE_AFTER_MS - 1000 }],
      resolveRoot: async () => "ses_root",
      rootIsConfigured: async () => managed,
      rootIsEnabled: async () => true,
      sendProbe: async (sessionID) => {
        sent.push(sessionID)
      },
      claim: () => true,
      log: () => {},
      now: () => clock,
    })
    expect(await scanner.scan()).toBe(0)
    expect(sent).toHaveLength(0)
    // TTL 内：仍用缓存，不生效。
    managed = true
    clock += 30_000
    expect(await scanner.scan()).toBe(0)
    // 超过 TTL：重读后识别为已配置。
    clock += 31_000
    expect(await scanner.scan()).toBe(1)
    expect(sent).toEqual(["ses_child"])
  })

  test("上下文压缩扫描器同样按 TTL 重读配置", async () => {
    stateDir()
    let clock = NOW
    let managed = false
    const compacted: string[] = []
    const scanner = createCtxCompactionScanner({
      listSessions: async () => [{ id: "ses_child", busy: clock - 1000 }],
      resolveRoot: async () => "ses_root",
      rootIsConfigured: async () => managed,
      rootIsEnabled: async () => true,
      readTokens: async () => 350_000,
      compactSession: async (sessionID) => {
        compacted.push(sessionID)
      },
      claim: () => true,
      log: () => {},
      now: () => clock,
    })
    expect(await scanner.scan()).toBe(0)
    managed = true
    clock += 30_000
    expect(await scanner.scan()).toBe(0)
    clock += 31_000
    expect(await scanner.scan()).toBe(1)
    expect(compacted).toEqual(["ses_child"])
  })
})