/** 扫描器卸载边界：列表查询尚未返回时 dispose，恢复后不得再发探针或压缩。 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createCtxCompactionScanner, createProbeScanner } from "./server-scanners"

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
