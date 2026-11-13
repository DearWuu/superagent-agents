/**
 * 限额备用模型的时间触发接线（server 侧）：
 *  - 首次限额失败只开始计时，不当场切模型；
 *  - 窗口内任一成功信号取消计时，到点未恢复才切一次；
 *  - 中断、非限额失败与会话删除放弃计时。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import plugin from "./server"

const cleanups: string[] = []

function tempState() {
  const dir = mkdtempSync(path.join(tmpdir(), "superagent-fallback-timeout-"))
  cleanups.push(dir)
  process.env.SUPERAGENT_STATE_DIR = dir
  process.env.XDG_STATE_HOME = dir
  process.env.SUPERAGENT_HOOK_LOG = path.join(dir, "hook.log")
  return dir
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
  delete process.env.SUPERAGENT_STATE_DIR
  delete process.env.XDG_STATE_HOME
  delete process.env.SUPERAGENT_HOOK_LOG
  delete process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS
})

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

/** 事件队列：订阅端按 push 顺序消费。 */
function eventQueue() {
  const buffered: any[] = []
  let notify: (() => void) | undefined
  let closed = false
  const iterable = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buffered.length > 0) {
          yield buffered.shift()
          continue
        }
        if (closed) return
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    },
  }
  return {
    iterable,
    push(event: any) {
      buffered.push(event)
      notify?.()
      notify = undefined
    },
    close() {
      closed = true
      notify?.()
      notify = undefined
    },
  }
}

const ROOT_ENTRIES = [
  { key: "superagent.max-subagents", value: 5 },
  { key: "superagent.fallback-enabled", value: "true" },
  { key: "superagent.fallback-model", value: "acme/backup" },
  { key: "superagent.subagent-fallback-model", value: "acme/backup" },
]

const quotaError = { type: "provider.rate-limit", message: "429 Too Many Requests", status: 429 }

async function setup() {
  const hooks: Record<string, any> = {}
  const switchModelCalls: Array<{ sessionID: string; model: any }> = []
  const events = eventQueue()
  /** 指令条目读取的挂起开关：用来制造「到点检查被成功事件打断」的竞态。 */
  const readGate = { hang: false, release: null as null | (() => void) }
  const ctx = {
    tool: {
      hook: async (name: string, handler: any) => {
        hooks[`tool:${name}`] = handler
        return { dispose() {} }
      },
    },
    event: { subscribe: () => events.iterable },
    skill: {
      transform: async (callback: any) => {
        callback({ get: () => undefined, add: () => {} })
        return { dispose() {} }
      },
    },
    agent: {
      async get({ agentID }: { agentID: string }) {
        return { data: { id: agentID, name: agentID } }
      },
    },
    session: {
      hook: async (name: string, handler: any) => {
        hooks[`session:${name}`] = handler
        return { dispose() {} }
      },
      async get({ sessionID }: { sessionID: string }) {
        if (sessionID === "ses_root") return { id: sessionID, parentID: undefined, time: {}, model: { providerID: "acme", id: "big" } }
        if (sessionID === "ses_child") return { id: sessionID, parentID: "ses_root", time: {}, model: { providerID: "acme", id: "big" } }
        throw new Error(`no session ${sessionID}`)
      },
      async list() {
        return { data: [] }
      },
      async context() {
        return []
      },
      async create() {
        throw new Error("not used")
      },
      async update() {},
      async remove() {},
      async prompt() {
        return { id: "msg_1" }
      },
      async interrupt() {
        return {}
      },
      async switchModel(input: { sessionID: string; model: any }) {
        switchModelCalls.push(structuredClone(input))
      },
      instructions: {
        entry: {
          async list({ sessionID }: { sessionID: string }) {
            if (readGate.hang) {
              readGate.hang = false
              await new Promise<void>((resolve) => {
                readGate.release = resolve
              })
            }
            if (sessionID === "ses_root") return structuredClone(ROOT_ENTRIES)
            return []
          },
          async put() {},
          async remove() {},
        },
      },
    },
  }
  const dispose = await (plugin as any).setup(ctx)
  return { hooks, switchModelCalls, events, dispose, readGate }
}

async function waitFor(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return check()
}

describe("限额备用：计时到点切换", () => {
  test("首次限额失败只计时，不当场切模型；到点后切一次", async () => {
    tempState()
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const h = await setup()
    const event: any = { sessionID: "ses_child", error: quotaError, model: { providerID: "acme", id: "big" }, decision: { retry: false } }
    await h.hooks["session:retry"](event)
    expect(h.switchModelCalls).toHaveLength(0)
    expect(hookLog().some((record) => record.event === "fallback-armed")).toBe(true)
    expect(await waitFor(() => h.switchModelCalls.length === 1)).toBe(true)
    expect(`${h.switchModelCalls[0].model.providerID}/${h.switchModelCalls[0].model.id}`).toBe("acme/backup")
    // 计时器切换改不了当次 retry 决策。
    expect(event.decision).toEqual({ retry: false })
    await h.dispose()
    h.events.close()
  })

  test("成功事件取消计时：到点也不再切模型", async () => {
    tempState()
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const h = await setup()
    const event: any = { sessionID: "ses_child", error: quotaError, model: { providerID: "acme", id: "big" }, decision: { retry: false } }
    await h.hooks["session:retry"](event)
    expect(hookLog().some((record) => record.event === "fallback-armed")).toBe(true)
    // 成功恢复：取消计时。
    h.events.push({ id: "evt_ok", type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(h.switchModelCalls).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })

  test("会话删除放弃计时：到点也不切模型", async () => {
    tempState()
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const h = await setup()
    const event: any = { sessionID: "ses_child", error: quotaError, model: { providerID: "acme", id: "big" }, decision: { retry: false } }
    await h.hooks["session:retry"](event)
    h.events.push({ id: "evt_del", type: "session.deleted", data: { sessionID: "ses_child" } })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(h.switchModelCalls).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })

  test("限额失败保留计时：失败事件不会取消窗口", async () => {
    tempState()
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const h = await setup()
    const event: any = { sessionID: "ses_child", error: quotaError, model: { providerID: "acme", id: "big" }, decision: { retry: false } }
    await h.hooks["session:retry"](event)
    h.events.push({
      id: "evt_fail",
      type: "session.execution.failed",
      data: { sessionID: "ses_child", error: quotaError },
    })
    expect(await waitFor(() => h.switchModelCalls.length === 1)).toBe(true)
    await h.dispose()
    h.events.close()
  })

  test("宿主没触发 retry 钩子：execution.failed 的限额错误也启动计时并切换", async () => {
    tempState()
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const h = await setup()
    // 只推失败事件：不经过 retry 钩子。
    h.events.push({
      id: "evt_failed_only",
      type: "session.execution.failed",
      data: { sessionID: "ses_child", error: quotaError },
    })
    expect(await waitFor(() => h.switchModelCalls.length === 1)).toBe(true)
    expect(`${h.switchModelCalls[0].model.providerID}/${h.switchModelCalls[0].model.id}`).toBe("acme/backup")
    expect(hookLog().some((record) => record.event === "fallback-armed")).toBe(true)
    await h.dispose()
    h.events.close()
  })

  test("retry 钩子已计时：随后的 execution.failed 不重复计时，只切一次", async () => {
    tempState()
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const h = await setup()
    const event: any = { sessionID: "ses_child", error: quotaError, model: { providerID: "acme", id: "big" }, decision: { retry: false } }
    await h.hooks["session:retry"](event)
    h.events.push({
      id: "evt_failed_after_retry",
      type: "session.execution.failed",
      data: { sessionID: "ses_child", error: quotaError },
    })
    expect(await waitFor(() => h.switchModelCalls.length === 1)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(h.switchModelCalls).toHaveLength(1)
    // 只起了一次计时。
    expect(hookLog().filter((record) => record.event === "fallback-armed")).toHaveLength(1)
    await h.dispose()
    h.events.close()
  })

  test("非限额失败放弃计时：到点也不切模型", async () => {
    tempState()
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const h = await setup()
    const event: any = { sessionID: "ses_child", error: quotaError, model: { providerID: "acme", id: "big" }, decision: { retry: false } }
    await h.hooks["session:retry"](event)
    h.events.push({
      id: "evt_fail2",
      type: "session.execution.failed",
      data: { sessionID: "ses_child", error: { type: "provider.timeout", message: "timed out" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(h.switchModelCalls).toHaveLength(0)
    expect(hookLog().some((record) => record.event === "fallback-model-switch")).toBe(false)
    await h.dispose()
    h.events.close()
  })

  test("失败步骤结束（finish=error）不取消计时：到点照常切", async () => {
    tempState()
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const h = await setup()
    const event: any = { sessionID: "ses_child", error: quotaError, model: { providerID: "acme", id: "big" }, decision: { retry: false } }
    await h.hooks["session:retry"](event)
    h.events.push({
      id: "evt_step_err",
      type: "session.step.ended",
      data: { sessionID: "ses_child", finish: "error" },
    })
    expect(await waitFor(() => h.switchModelCalls.length === 1)).toBe(true)
    await h.dispose()
    h.events.close()
  })

  test("成功步骤结束（finish=stop）取消计时：到点不切", async () => {
    tempState()
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const h = await setup()
    const event: any = { sessionID: "ses_child", error: quotaError, model: { providerID: "acme", id: "big" }, decision: { retry: false } }
    await h.hooks["session:retry"](event)
    h.events.push({
      id: "evt_step_ok",
      type: "session.step.ended",
      data: { sessionID: "ses_child", finish: "stop" },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(h.switchModelCalls).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })

  test("步骤结束（finish=length）视为已恢复：取消计时，到点不切", async () => {
    tempState()
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const h = await setup()
    const event: any = { sessionID: "ses_child", error: quotaError, model: { providerID: "acme", id: "big" }, decision: { retry: false } }
    await h.hooks["session:retry"](event)
    h.events.push({
      id: "evt_step_length",
      type: "session.step.ended",
      data: { sessionID: "ses_child", finish: "length" },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(h.switchModelCalls).toHaveLength(0)
    expect(hookLog().some((record) => record.event === "fallback-model-switch")).toBe(false)
    await h.dispose()
    h.events.close()
  })

  test("到点检查期间收到成功事件：不再切模型", async () => {
    tempState()
    process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS = "20"
    const h = await setup()
    const event: any = { sessionID: "ses_child", error: quotaError, model: { providerID: "acme", id: "big" }, decision: { retry: false } }
    await h.hooks["session:retry"](event)
    // 让到点时的配置读取卡住，期间插一个成功事件。
    h.readGate.hang = true
    await waitFor(() => h.readGate.release !== null, 3000)
    h.events.push({ id: "evt_ok2", type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    h.readGate.release?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.switchModelCalls).toHaveLength(0)
    await h.dispose()
    h.events.close()
  })
})
