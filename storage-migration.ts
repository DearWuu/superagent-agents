import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Plugin ids this package used before adopting its own namespace. */
export const LEGACY_PLUGIN_IDS = ["opencode.sidebar.agents", "superagent.sidebar.agents"] as const

/** Durable TUI storage lives beside the other per-channel state files. */
export function storageDirectory(channel: string) {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "opencode", channel, "tui")
}

/**
 * Plugin ids changed from the official `opencode.*` namespace to this
 * package's own. TUI storage files embed the plugin id, so carry existing
 * settings over once instead of starting from defaults.
 *
 * Returns true when a legacy file was copied. The current file always wins:
 * once it exists this is a no-op, so a later id change cannot clobber it.
 */
export function migrateLegacyPluginStorage(directory: string, storeKey: string, pluginID: string) {
  const target = join(directory, `plugin.${pluginID}.${storeKey}.json`)
  if (existsSync(target)) return false
  for (const legacyID of LEGACY_PLUGIN_IDS) {
    const legacy = join(directory, `plugin.${legacyID}.${storeKey}.json`)
    if (!existsSync(legacy)) continue
    mkdirSync(directory, { recursive: true })
    copyFileSync(legacy, target)
    return true
  }
  return false
}