import { describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateLegacyPluginStorage } from "./storage-migration"

const STORE = "superagent.agents"
const ID = "superagent.agents"

function directory() {
  return mkdtempSync(join(tmpdir(), "superagent-storage-"))
}

function file(directory: string, pluginID: string) {
  return join(directory, `plugin.${pluginID}.${STORE}.json`)
}

describe("legacy plugin storage migration", () => {
  test("copies the pre-rename opencode.* file to the new id", () => {
    const dir = directory()
    writeFileSync(file(dir, "opencode.sidebar.agents"), '{"roots":{"root":{"maxSubagents":7}}}')
    expect(migrateLegacyPluginStorage(dir, STORE, ID)).toBe(true)
    expect(JSON.parse(readFileSync(file(dir, ID), "utf8"))).toEqual({ roots: { root: { maxSubagents: 7 } } })
    // The old file is left in place: another build may still read it.
    expect(existsSync(file(dir, "opencode.sidebar.agents"))).toBe(true)
  })

  test("falls back to the older superagent.sidebar.agents id", () => {
    const dir = directory()
    writeFileSync(file(dir, "superagent.sidebar.agents"), '{"roots":{}}')
    expect(migrateLegacyPluginStorage(dir, STORE, ID)).toBe(true)
    expect(existsSync(file(dir, ID))).toBe(true)
  })

  test("prefers the newest legacy id when both exist", () => {
    const dir = directory()
    writeFileSync(file(dir, "opencode.sidebar.agents"), '{"from":"opencode"}')
    writeFileSync(file(dir, "superagent.sidebar.agents"), '{"from":"superagent"}')
    migrateLegacyPluginStorage(dir, STORE, ID)
    expect(JSON.parse(readFileSync(file(dir, ID), "utf8"))).toEqual({ from: "opencode" })
  })

  test("never overwrites settings the new id already owns", () => {
    const dir = directory()
    writeFileSync(file(dir, "opencode.sidebar.agents"), '{"from":"legacy"}')
    writeFileSync(file(dir, ID), '{"from":"current"}')
    expect(migrateLegacyPluginStorage(dir, STORE, ID)).toBe(false)
    expect(JSON.parse(readFileSync(file(dir, ID), "utf8"))).toEqual({ from: "current" })
  })

  test("does nothing without a legacy file", () => {
    const dir = directory()
    expect(migrateLegacyPluginStorage(dir, STORE, ID)).toBe(false)
    expect(existsSync(file(dir, ID))).toBe(false)
  })
})