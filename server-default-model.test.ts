/**
 * 默认模型派工纯逻辑：策略读取、优先级链、variant 等价与可用性校验；
 * 另用 executeSubagentWithInterrupt 验证「只注入交宿主的输入」与回执行为。
 */
import { describe, expect, test } from "bun:test"

import {
  collectModelKeys,
  isModelAvailable,
  readDefaultPolicy,
  readPerChildPolicy,
  resolveDispatchModel,
} from "./server-default-model"
import { executeSubagentWithInterrupt } from "./server"
import { createDispatchLedger } from "./subagent-status"

const entry = (key: string, value: unknown) => ({ key, value })

describe("readDefaultPolicy", () => {
  test("无条目：unset，无模型", () => {
    expect(readDefaultPolicy([])).toEqual({ policy: "unset" })
    expect(readDefaultPolicy(undefined)).toEqual({ policy: "unset" })
  })

  test("只有 default-model：按 fixed 推断并带模型", () => {
    const state = readDefaultPolicy([entry("superagent.default-model", "openai/gpt-5")])
    expect(state.policy).toBe("fixed")
    expect(state.model).toMatchObject({ providerID: "openai", id: "gpt-5" })
  })

  test("fixed 带/不带模型都保留策略", () => {
    expect(readDefaultPolicy([entry("superagent.default-policy", "fixed")]).policy).toBe("fixed")
    const withModel = readDefaultPolicy([
      entry("superagent.default-policy", "fixed"),
      entry("superagent.default-model", "openai/gpt-5#high"),
    ])
    expect(withModel.policy).toBe("fixed")
    expect(withModel.model).toMatchObject({ providerID: "openai", id: "gpt-5", variant: "high" })
  })

  test("inherit / auto 不绑定模型", () => {
    expect(readDefaultPolicy([entry("superagent.default-policy", "INHERIT")])).toEqual({ policy: "inherit" })
    expect(readDefaultPolicy([entry("superagent.default-policy", " auto ")])).toEqual({ policy: "auto" })
  })

  test("取值不认识：有模型按 fixed，无模型按 unset", () => {
    expect(
      readDefaultPolicy([
        entry("superagent.default-policy", "bogus"),
        entry("superagent.default-model", "openai/gpt-5"),
      ]).policy,
    ).toBe("fixed")
    expect(readDefaultPolicy([entry("superagent.default-policy", "bogus")])).toEqual({ policy: "unset" })
  })
})

describe("readPerChildPolicy", () => {
  test("三种合法取值", () => {
    expect(readPerChildPolicy({ "superagent.model-policy": "auto" })).toBe("auto")
    expect(readPerChildPolicy({ "superagent.model-policy": "inherit" })).toBe("inherit")
    expect(readPerChildPolicy({ "superagent.model-policy": "FIXED" })).toBe("fixed")
  })

  test("缺失、非法与非字符串一律 undefined", () => {
    expect(readPerChildPolicy(undefined)).toBeUndefined()
    expect(readPerChildPolicy({})).toBeUndefined()
    expect(readPerChildPolicy({ "superagent.model-policy": "bogus" })).toBeUndefined()
    expect(readPerChildPolicy({ "superagent.model-policy": true })).toBeUndefined()
  })
})

describe("resolveDispatchModel", () => {
  const base = { policy: "fixed" as const, defaultModel: "openai/gpt-5", rootModel: "openai/gpt-5", steer: false }

  test("显式 model 一律不注入", () => {
    expect(resolveDispatchModel({ ...base, explicitModel: "zhipuai/glm" })).toEqual({ reason: "explicit" })
  })

  test("fixed 新建：注入默认模型", () => {
    const result = resolveDispatchModel(base)
    expect(result.reason).toBe("fixed")
    expect(result.target).toMatchObject({ providerID: "openai", id: "gpt-5" })
  })

  test("fixed 但默认模型缺失：只有 reason，无 target", () => {
    expect(resolveDispatchModel({ ...base, defaultModel: undefined })).toEqual({ reason: "fixed" })
  })

  test("inherit：注入 root 模型", () => {
    const result = resolveDispatchModel({ ...base, policy: "inherit", defaultModel: undefined, rootModel: "base/root" })
    expect(result.reason).toBe("inherit")
    expect(result.target).toMatchObject({ providerID: "base", id: "root" })
  })

  test("auto 与 unset 不注入", () => {
    expect(resolveDispatchModel({ ...base, policy: "auto" })).toEqual({ reason: "auto" })
    expect(resolveDispatchModel({ ...base, policy: "unset" })).toEqual({ reason: "unset" })
  })

  test("续跑带有效委派标记：不注入", () => {
    const child = {
      model: "zhipuai/glm",
      metadata: {
        "superagent.model-delegation": { model: "zhipuai/glm", at: 1, source: "explicit-subagent-model" },
      },
    }
    expect(resolveDispatchModel({ ...base, steer: true, child })).toEqual({ reason: "delegated" })
  })

  test("每子代理策略：auto/fixed 不注入，inherit 走 root 模型", () => {
    expect(
      resolveDispatchModel({ ...base, steer: true, child: { metadata: { "superagent.model-policy": "auto" } } }),
    ).toEqual({ reason: "per-child-auto" })
    expect(
      resolveDispatchModel({ ...base, steer: true, child: { metadata: { "superagent.model-policy": "fixed" } } }),
    ).toEqual({ reason: "per-child-fixed" })
    const inherit = resolveDispatchModel({
      ...base,
      policy: "inherit",
      rootModel: "base/root",
      steer: true,
      child: { model: "other/old", metadata: { "superagent.model-policy": "inherit" } },
    })
    expect(inherit.reason).toBe("inherit")
    expect(inherit.target).toMatchObject({ providerID: "base", id: "root" })
  })

  test("续跑且目标与当前模型相同：短路为 same（variant 缺省与 default 等价）", () => {
    expect(resolveDispatchModel({ ...base, steer: true, child: { model: "openai/gpt-5" } })).toEqual({
      reason: "same",
    })
    expect(
      resolveDispatchModel({ ...base, steer: true, child: { model: "openai/gpt-5#default" } }),
    ).toEqual({ reason: "same" })
  })

  test("新建不做同模型短路：首步就要落到目标模型", () => {
    const result = resolveDispatchModel({ ...base, steer: false, child: { model: "openai/gpt-5" } })
    expect(result.reason).toBe("fixed")
    expect(result.target).toBeDefined()
  })
})

describe("collectModelKeys / isModelAvailable", () => {
  test("兼容 {data:[...]} 与数组两种返回，跳过残缺项", () => {
    const keys = collectModelKeys({
      data: [
        { providerID: "a", id: "b" },
        { providerID: "c", modelID: "d" },
        { id: "orphan" },
        { providerID: "e" },
        "junk",
      ],
    })
    expect([...keys].sort()).toEqual(["a/b", "c/d"])
    expect(collectModelKeys([{ providerID: "x", id: "y" }])).toEqual(new Set(["x/y"]))
  })

  test("variant 不参与可用性判定", () => {
    const keys = collectModelKeys([{ providerID: "a", id: "b" }])
    expect(isModelAvailable(keys, { providerID: "a", id: "b", variant: "high" })).toBe(true)
    expect(isModelAvailable(keys, { providerID: "a", id: "z" })).toBe(false)
  })
})

describe("executeSubagentWithInterrupt 默认模型注入", () => {
  function harness(opts: { resolver?: (input: any, context: any) => Promise<any> } = {}) {
    const ledger = createDispatchLedger(10)
    ledger.begin("call-1", { parentID: "ses_root" } as any)
    const nativeCalls: any[] = []
    const native = async (input: any) => {
      nativeCalls.push(input)
      return { output: "done", metadata: { sessionID: "ses_child", status: "completed" } }
    }
    const run = (input: any) =>
      executeSubagentWithInterrupt(
        {} as any,
        native,
        input,
        { id: "call-1", sessionID: "ses_root", signal: new AbortController().signal },
        ledger,
        undefined,
        opts.resolver,
      )
    return { ledger, nativeCalls, run }
  }

  test("解析出模型：只改写交宿主的输入，回执标「（默认策略）」", async () => {
    const h = harness({ resolver: async () => ({ model: "openai/gpt-5", reason: "fixed" }) })
    const input = { agent: "worker", description: "任务", prompt: "go" }
    const result = await h.run(input)
    expect(h.nativeCalls).toHaveLength(1)
    expect(h.nativeCalls[0]).toMatchObject({ prompt: "go", model: "openai/gpt-5" })
    expect(input).toEqual({ agent: "worker", description: "任务", prompt: "go" })
    expect(result.output).toContain("（默认策略）")
  })

  test("显式 model：不调用解析器，输入不变", async () => {
    let called = 0
    const h = harness({
      resolver: async () => {
        called += 1
        return { model: "openai/gpt-5", reason: "fixed" }
      },
    })
    await h.run({ agent: "worker", prompt: "go", model: "zhipuai/glm" })
    expect(called).toBe(0)
    expect(h.nativeCalls[0]).toMatchObject({ model: "zhipuai/glm" })
  })

  test("解析告警：不注入并写进回执", async () => {
    const h = harness({
      resolver: async () => ({ reason: "fixed", warning: "默认模型 openai/gpt-5 未能确认可用，已按继承模型派工" }),
    })
    const result = await h.run({ agent: "worker", prompt: "go" })
    expect(h.nativeCalls[0].model).toBeUndefined()
    expect(result.output).toContain("未能确认可用")
  })

  test("解析抛错：照常派工，无模型注入", async () => {
    const h = harness({
      resolver: async () => {
        throw new Error("boom")
      },
    })
    const result = await h.run({ agent: "worker", prompt: "go" })
    expect(h.nativeCalls).toHaveLength(1)
    expect(h.nativeCalls[0].model).toBeUndefined()
    expect(result.output).toContain("done")
  })
})