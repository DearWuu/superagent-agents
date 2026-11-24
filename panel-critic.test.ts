/** 面板 critic / 监管审计路径与 server 共用同一份状态根：SUPERAGENT_STATE_DIR 优先。 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { criticDirectory, oversightAuditPath } from "./panel-critic"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "panel-critic-"))
  process.env.SUPERAGENT_STATE_DIR = root
  delete process.env.XDG_STATE_HOME
})

afterEach(() => {
  delete process.env.SUPERAGENT_STATE_DIR
  rmSync(root, { recursive: true, force: true })
})

describe("panel-critic 路径解析", () => {
  test("criticDirectory 走 SUPERAGENT_STATE_DIR", () => {
    expect(criticDirectory()).toBe(join(root, "critic"))
  })

  test("oversightAuditPath 走同一状态根，按天分文件", () => {
    expect(oversightAuditPath(new Date("2026-01-02T03:04:05Z"))).toBe(
      join(root, "oversight", "2026-01-02.jsonl"),
    )
  })
})