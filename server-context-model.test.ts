/**
 * 上下文提醒按模型窗口收紧阈值：复用 context-policy 的
 * `min(300K, floor(window * 0.8))`，通过 `ctx.model.list` 的 limit.context
 * 查询并缓存；查询失败回退 300K。
 */
import { describe, expect, test } from "bun:test"

import { CONTEXT_WARN_TOKENS, createCtxContextWarningScanner, ctxWarningText } from "./server"

const NOW = 1_800_000_000_000

function modelInfo(providerID: string, id: string, context: number) {
  return { providerID, id, modelID: id, limit: { context, output: 8192 } }
}

function harness(options: {
  tokens: number
  model?: any
  models?: any[]
  modelListFails?: boolean
  modelList?: () => Promise<any>
  listWithoutModel?: boolean
}) {
  const prompts: Array<{ sessionID: string; text: string }> = []
  const logs: any[] = []
  let listCalls = 0
  const sessions = new Map<string, any>([
    ["ses_root", { id: "ses_root", title: "root", time: {} }],
    ["ses_child", { id: "ses_child", parentID: "ses_root", title: "任务", model: options.model, time: { busy: NOW - 500 } }],
  ])
  const ctx = {
    session: {
      async list() {
        const data = [...sessions.values()].map((session) =>
          options.listWithoutModel ? { ...session, model: undefined } : session,
        )
        return { data }
      },
      async get({ sessionID }: { sessionID: string }) {
        const found = sessions.get(sessionID)
        if (!found) throw new Error(`no session ${sessionID}`)
        return found
      },
      async context() {
        return [{ type: "assistant", tokens: { input: options.tokens, cache: { read: 0, write: 0 } } }]
      },
      async prompt(input: any) {
        prompts.push(input)
        return { id: "msg_1" }
      },
      instructions: {
        entry: {
          async list() {
            return [{ key: "superagent.max-subagents", value: 5 }]
          },
        },
      },
    },
    model: {
      async list() {
        listCalls++
        if (options.modelList) return options.modelList()
        if (options.modelListFails) throw new Error("model service down")
        return { data: options.models ?? [] }
      },
    },
  }
  const scanner = createCtxContextWarningScanner(ctx as any, {
    now: () => NOW,
    claim: () => true,
    log: (record) => logs.push(record),
  })
  return { scanner, prompts, logs, listCalls: () => listCalls }
}

describe("按模型窗口提醒", () => {
  const model = { providerID: "acme", id: "small" }

  test("窗口 100K → 阈值 80K；85K 触发、79K 不触发", async () => {
    const models = [modelInfo("acme", "small", 100_000)]
    const high = harness({ tokens: 85_000, model, models })
    expect(await high.scanner.scan()).toBe(1)
    expect(high.prompts[0].text).toBe(ctxWarningText("任务", "ses_child", 85_000, 80_000))
    expect(high.prompts[0].text).toContain(">80k")

    const low = harness({ tokens: 79_000, model, models })
    expect(await low.scanner.scan()).toBe(0)
  })

  test("严格超过阈值才提醒（80K 本身不触发）", async () => {
    const h = harness({ tokens: 80_000, model, models: [modelInfo("acme", "small", 100_000)] })
    expect(await h.scanner.scan()).toBe(0)
  })

  test("窗口大时仍以 300K 为上限", async () => {
    const large = { providerID: "acme", id: "large" }
    const h = harness({ tokens: 301_000, model: large, models: [modelInfo("acme", "large", 1_000_000)] })
    expect(await h.scanner.scan()).toBe(1)
    expect(h.prompts[0].text).toContain(">300k")
  })

  test("模型未知或列表缺失回退 300K", async () => {
    const unknown = harness({ tokens: 299_000, model: { providerID: "acme", id: "nope" }, models: [] })
    expect(await unknown.scanner.scan()).toBe(0)
    expect(CONTEXT_WARN_TOKENS).toBe(300_000)

    const hit = harness({ tokens: 301_000, model: { providerID: "acme", id: "nope" }, models: [] })
    expect(await hit.scanner.scan()).toBe(1)
    expect(hit.prompts[0].text).toContain(">300k")
  })

  test("查询失败回退 300K 并留日志", async () => {
    const h = harness({ tokens: 301_000, model, modelListFails: true })
    expect(await h.scanner.scan()).toBe(1)
    expect(h.prompts[0].text).toContain(">300k")
    expect(h.logs.some((record) => record.event === "ctx-model-lookup-failed")).toBe(true)
  })

  test("同一模型窗口只查一次（缓存）", async () => {
    const h = harness({ tokens: 85_000, model, models: [modelInfo("acme", "small", 100_000)] })
    expect(await h.scanner.scan()).toBe(1)
    expect(await h.scanner.scan()).toBe(1)
    expect(h.listCalls()).toBe(1)
  })

  test("列表没有 model 时回退到 session.get", async () => {
    const h = harness({
      tokens: 85_000,
      model,
      models: [modelInfo("acme", "small", 100_000)],
      listWithoutModel: true,
    })
    expect(await h.scanner.scan()).toBe(1)
    expect(h.prompts[0].text).toContain(">80k")
    expect(h.listCalls()).toBe(1)
  })
})