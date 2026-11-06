/** @jsxImportSource @opentui/solid */
/**
 * 协作模式总开关：TUI 与 server 两侧各自读同一份配置文件，
 * 停用时服务端钩子全部短路（不拦截、不计数、不切换、不复核、不探针）。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import plugin, {
  COLLAB_SWITCH_TTL_MS,
  collabEnabled,
  collabSwitchPath,
  createProbeScanner,
  readCollabSwitch,
  readCollabSwitchState,
  resetCollabSwitchCache,
  PROBE_AFTER_MS,
} from "./server"

mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (value: unknown) => value } }))
const tui = await import("./index")

let root: string
const saved: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined) {
  saved[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "superagent-collab-"))
  setEnv("XDG_CONFIG_HOME", path.join(root, "config"))
  setEnv("XDG_STATE_HOME", path.join(root, "state"))
  setEnv("SUPERAGENT_HOOK_LOG", path.join(root, "hook.log"))
  setEnv("SUPERAGENT_STATE_DIR", path.join(root, "state-root"))
  resetCollabSwitchCache()
  tui.resetCollabSwitchCache()
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) setEnv(key, value)
  resetCollabSwitchCache()
  tui.resetCollabSwitchCache()
  rmSync(root, { recursive: true, force: true })
})

function writeSwitch(value: string | Record<string, unknown>) {
  const file = collabSwitchPath()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8")
}

function hookLog(): any[] {
  try {
    return readFileSync(process.env.SUPERAGENT_HOOK_LOG!, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/** 捕获 setup 注册的钩子，并统计服务端调用次数。 */
function fakeCtx() {
  const hooks: Record<string, any> = {}
  const calls = { instructions: 0, switchModel: 0, prompt: 0, create: 0, list: 0 }
  const buffered: any[] = []
  let notify: (() => void) | undefined
  const events = {
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (buffered.length > 0) {
            yield buffered.shift()
            continue
          }
          await new Promise<void>((resolve) => {
            notify = resolve
          })
        }
      },
    },
    push(event: any) {
      buffered.push(event)
      notify?.()
      notify = undefined
    },
    close() {
      notify?.()
      notify = undefined
    },
  }
  const ctx = {
    tool: {
      hook: async (name: string, handler: any) => {
        hooks[`tool:${name}`] = handler
        return { dispose() {} }
      },
    },
    session: {
      hook: async (name: string, handler: any) => {
        hooks[`session:${name}`] = handler
        return { dispose() {} }
      },
      async get({ sessionID }: { sessionID: string }) {
        return { id: sessionID, parentID: sessionID === "ses_child" ? "ses_root" : undefined, time: {} }
      },
      async list() {
        calls.list++
        return { data: [] }
      },
      async create(input: any) {
        calls.create++
        return { id: "ses_critic", parentID: input.parentID, time: { busy: 1, idle: 2 } }
      },
      async update() {},
      async remove() {},
      async prompt() {
        calls.prompt++
      },
      async switchModel() {
        calls.switchModel++
      },
      instructions: {
        entry: {
          async list() {
            calls.instructions++
            return []
          },
          async put() {},
        },
      },
    },
    event: { subscribe: () => events.iterable },
  }
  return { ctx, hooks, calls, events }
}

const quotaError = { message: "429 rate limit exceeded" }

describe("readCollabSwitch", () => {
  test("配置文件不存在时按启用处理", () => {
    expect(readCollabSwitch()).toBe(true)
    expect(readCollabSwitchState().reason).toBe("default")
  })

  test("enabled=false 即停用", () => {
    writeSwitch({ enabled: false })
    expect(readCollabSwitch()).toBe(false)
    expect(readCollabSwitchState().reason).toBe("configured")
  })

  test("JSON 损坏时按启用处理，并在 hook.log 留记录", () => {
    writeSwitch("{ not json")
    expect(readCollabSwitch()).toBe(true)
    expect(readCollabSwitchState().reason).toBe("corrupt")
    expect(collabEnabled()).toBe(true)
    expect(hookLog().some((record) => record.event === "collab-switch-corrupt")).toBe(true)
  })

  test("enabled 不是布尔值时按启用处理", () => {
    writeSwitch({ enabled: "no" })
    expect(readCollabSwitch()).toBe(true)
  })

  test("短缓存生效：TTL 内不重读，过期后跟随文件", () => {
    writeSwitch({ enabled: false })
    expect(readCollabSwitch(1_000)).toBe(false)
    writeSwitch({ enabled: true })
    expect(readCollabSwitch(1_001)).toBe(false)
    expect(readCollabSwitch(1_000 + COLLAB_SWITCH_TTL_MS + 1)).toBe(true)
  })

  test("路径跟随 XDG_CONFIG_HOME", () => {
    expect(collabSwitchPath()).toBe(path.join(root, "config", "opencode", "superagent.json"))
  })
})

describe("TUI 侧读写", () => {
  test("与 server 读同一路径：写 false 后两侧都读到停用", async () => {
    await tui.writeCollabSwitch(false)
    expect(tui.collabSwitchPath()).toBe(collabSwitchPath())
    expect(tui.readCollabEnabled()).toBe(false)
    resetCollabSwitchCache()
    expect(readCollabSwitch()).toBe(false)
    expect(JSON.parse(readFileSync(collabSwitchPath(), "utf8"))).toEqual({ enabled: false })
  })

  test("切换幂等：重复写同一状态结果一致，开启后恢复启用", async () => {
    await tui.writeCollabSwitch(false)
    await tui.writeCollabSwitch(false)
    resetCollabSwitchCache()
    expect(readCollabSwitch()).toBe(false)
    await tui.writeCollabSwitch(true)
    resetCollabSwitchCache()
    expect(readCollabSwitch()).toBe(true)
  })
})

describe("停用时服务端零副作用", () => {
  test("硬拦截不执行：subagent 调用直接放行，不查会话、不拒绝", async () => {
    writeSwitch({ enabled: false })
    const { ctx, hooks, calls } = fakeCtx()
    const dispose = await (plugin as any).setup(ctx)

    await expect(
      hooks["tool:execute.before"]({ tool: "subagent", sessionID: "ses_root", id: "call_1", agent: "build" }),
    ).resolves.toBeUndefined()
    expect(calls.list).toBe(0)
    expect(calls.instructions).toBe(0)

    await dispose()
  })

  test("备用模型切换不执行：限额错误不计数、不查配置、不切模型", async () => {
    writeSwitch({ enabled: false })
    const { ctx, hooks, calls } = fakeCtx()
    const dispose = await (plugin as any).setup(ctx)

    await hooks["session:retry"]({ sessionID: "ses_root", error: quotaError, model: { providerID: "acme", id: "big" } })
    expect(calls.instructions).toBe(0)
    expect(calls.switchModel).toBe(0)

    await dispose()
  })

  test("启用后同一 retry 钩子会去读配置（对照）", async () => {
    const { ctx, hooks, calls } = fakeCtx()
    const dispose = await (plugin as any).setup(ctx)

    await hooks["session:retry"]({ sessionID: "ses_root", error: quotaError, model: { providerID: "acme", id: "big" } })
    expect(calls.instructions).toBeGreaterThan(0)

    await dispose()
  })

  test("critic 复核不触发：完成事件不发复核会话、不发提示词", async () => {
    writeSwitch({ enabled: false })
    const { ctx, events, calls } = fakeCtx()
    const dispose = await (plugin as any).setup(ctx)

    events.push({ id: "evt_1", type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(calls.create).toBe(0)
    expect(calls.prompt).toBe(0)

    events.close()
    await dispose()
  })

  test("探针不发：整轮扫描不列会话", async () => {
    writeSwitch({ enabled: false })
    let listed = 0
    let sent = 0
    const scanner = createProbeScanner({
      enabled: () => collabEnabled(),
      listSessions: async () => {
        listed++
        return [{ id: "ses_child", busy: Date.now() - PROBE_AFTER_MS - 1 }]
      },
      resolveRoot: async () => "ses_root",
      rootIsConfigured: async () => true,
      sendProbe: async () => {
        sent++
      },
      log: () => {},
    })

    expect(await scanner.scan()).toBe(0)
    expect(listed).toBe(0)
    expect(sent).toBe(0)
  })

  test("开关翻转在 hook.log 留 disabled/enabled 记录", () => {
    writeSwitch({ enabled: false })
    expect(collabEnabled()).toBe(false)
    writeSwitch({ enabled: true })
    resetCollabSwitchCache()
    expect(collabEnabled()).toBe(true)
    const events = hookLog().map((record) => record.event)
    expect(events).toContain("collab-switch-disabled")
    expect(events).toContain("collab-switch-enabled")
  })
})