/** TUI 模型偏好文件：recent/favorite/variant 的读写与串行更新。 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type PreferenceModel = { providerID: string; modelID: string }
export type ModelPreference = {
  recent: PreferenceModel[]
  favorite: PreferenceModel[]
  variant: Record<string, string | undefined>
}

export function defaultModelPreferencePath() {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "opencode", "model.json")
}

export function preferenceModels(value: unknown): PreferenceModel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): PreferenceModel[] => {
    if (!item || typeof item !== "object") return []
    const record = item as Record<string, unknown>
    if (typeof record.providerID !== "string" || !record.providerID) return []
    if (typeof record.modelID !== "string" || !record.modelID) return []
    return [{ providerID: record.providerID, modelID: record.modelID }]
  })
}

export function decodePreferences(value: unknown) {
  const root = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return {
    document: root,
    preference: {
      recent: preferenceModels(root.recent),
      favorite: preferenceModels(root.favorite),
      variant: root.variant && typeof root.variant === "object" ? (root.variant as ModelPreference["variant"]) : {},
    } satisfies ModelPreference,
  }
}

export function recentModels(model: PreferenceModel, recent: PreferenceModel[]) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
}

export function favoriteModels(model: PreferenceModel, favorite: PreferenceModel[], enabled: boolean) {
  const current = favorite.filter((item) => !(item.providerID === model.providerID && item.modelID === model.modelID))
  return enabled ? [model, ...current] : current
}

export async function readModelPreference(filePath: string) {
  try {
    return decodePreferences(JSON.parse(await readFile(filePath, "utf8")))
  } catch {
    return decodePreferences(undefined)
  }
}

export async function writeModelPreference(filePath: string, document: Record<string, unknown>) {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", "utf8")
  await rename(temporary, filePath)
}

let preferenceWrite: Promise<unknown> = Promise.resolve()

export async function updateModelPreference(
  filePath: string,
  change: (current: ModelPreference) => Partial<ModelPreference>,
) {
  const run = preferenceWrite.then(async () => {
    const { document, preference } = await readModelPreference(filePath)
    const patch = change(preference)
    const next = {
      ...document,
      ...(patch.recent === undefined ? {} : { recent: preferenceModels(patch.recent) }),
      ...(patch.favorite === undefined ? {} : { favorite: preferenceModels(patch.favorite) }),
      ...(patch.variant === undefined ? {} : { variant: patch.variant }),
    }
    await writeModelPreference(filePath, next)
    return decodePreferences(next).preference
  })
  preferenceWrite = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
