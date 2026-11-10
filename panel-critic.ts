/** TUI 面板的 critic 记录与监管审计事件读取。 */

import { appendFile, mkdir, readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type CriticRecord = { verdict: string; differences: string[]; ts: string }

export function criticDirectory() {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "opencode", "superagent", "critic")
}

/** Latest critic audit row per reviewed child session. */
export async function readCriticRecords(directory: string) {
  const records = new Map<string, CriticRecord>()
  const files = await readdir(directory).catch(() => [] as string[])
  for (const file of files.filter((name) => name.endsWith(".jsonl")).sort()) {
    const text = await readFile(join(directory, file), "utf8").catch(() => "")
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      let row: Record<string, unknown>
      try {
        row = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof row.childSessionID !== "string" || typeof row.verdict !== "string") continue
      const ts = typeof row.ts === "string" ? row.ts : ""
      const previous = records.get(row.childSessionID)
      if (previous && previous.ts > ts) continue
      records.set(row.childSessionID, {
        verdict: row.verdict,
        differences: Array.isArray(row.differences)
          ? row.differences.filter((item): item is string => typeof item === "string")
          : [],
        ts,
      })
    }
  }
  return records
}

/** The mark of one verdict: agreeing reviews fade out, disagreement warns. */
export function criticView(verdict: string) {
  if (verdict === "一致") return { text: "✓复核", warning: false }
  if (verdict === "部分不一致" || verdict === "严重不一致") return { text: "⚠复核", warning: true }
  return { text: "?复核", warning: false }
}

export function oversightAuditPath(date = new Date()) {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "opencode", "superagent", "oversight", `${date.toISOString().slice(0, 10)}.jsonl`)
}

export async function appendOversightEvent(type: string, payload: Record<string, unknown>) {
  const file = oversightAuditPath()
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify({ v: 1, ts: new Date().toISOString(), type, ...payload }) + "\n", "utf8")
}

export async function recentOversightEvents(limit = 20) {
  const file = oversightAuditPath()
  const lines = await readFile(file, "utf8")
    .then((text) => text.trim().split("\n").filter(Boolean).slice(-limit))
    .catch(() => [])
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}
