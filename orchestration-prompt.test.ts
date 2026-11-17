/**
 * 编排/汇报提示词的硬约束与默认升级机制：
 * - 常驻 sessionPrompt 前部的派工硬约束；
 * - 报告时间取真实工具/通知时间，取不到写「未知」；
 * - 默认 sessionPrompt 变更后，旧默认按 LEGACY_SESSION_PROMPTS 升级，用户自定义保留。
 */
import { describe, expect, test } from "bun:test"

import {
  INSTRUCTION_KEYS,
  LEGACY_ASSIGNMENT_PROMPTS,
  LEGACY_SESSION_PROMPTS,
  LEGACY_TASK_PROMPTS,
  SUPERAGENT_DEFAULTS,
} from "./panel-defaults"
import { createInstructionActions } from "./panel-instructions"
import { defaultRootSettings } from "./session-scope"
import { SUPERAGENT_ACCEPTANCE_SKILL, SUPERAGENT_ORCHESTRATION_SKILL } from "./skills"

const ROOT = "root"

/** 指令条目存储 + 客户端假件：驱动真实的 createInstructionActions。 */
function harness(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  const writes: Array<{ key: string; value: unknown }> = []
  const context = {
    client: {
      experimental: {
        session: {
          instructions: {
            entry: {
              list: async () => [...store].map(([key, value]) => ({ key, value })),
              put: async ({ key, value }: { key: string; value: unknown }) => {
                writes.push({ key, value })
                store.set(key, value)
              },
              remove: async ({ key }: { key: string }) => {
                store.delete(key)
              },
            },
          },
        },
      },
    },
    ui: { toast: { show: () => {} } },
  }
  let instructions: { rootID?: string; values: Record<string, unknown> } = { values: {} }
  const setInstructions = (
    next:
      | { rootID?: string; values: Record<string, unknown> }
      | ((current: { rootID?: string; values: Record<string, unknown> }) => {
          rootID?: string
          values: Record<string, unknown>
        }),
  ) => {
    instructions = typeof next === "function" ? next(instructions) : next
    return instructions
  }
  const root = defaultRootSettings()
  root.initialized = { [ROOT]: true }
  const actions = createInstructionActions({
    context: context as never,
    rootSessionID: () => ROOT,
    collabOn: () => true,
    root: () => root,
    models: () => [],
    instructionValue: (key) => (instructions.rootID === ROOT ? instructions.values[key] : undefined),
    instructionText: (key) => {
      const value = instructionValueOf(key)
      return typeof value === "string" ? value : typeof value === "number" ? String(value) : ""
    },
    instructionPresent: (key) => {
      const value = instructionValueOf(key)
      return value !== undefined && value !== null && String(value).trim() !== ""
    },
    updateRoot: (mutation) => mutation(root),
    updateGlobal: () => {},
    setInstructions: setInstructions as never,
    setReady: (() => {}) as never,
  })
  const instructionValueOf = (key: string) =>
    instructions.rootID === ROOT ? instructions.values[key] : undefined
  return { actions, store, writes, root }
}

describe("常驻 sessionPrompt 的派工硬约束", () => {
  const prompt = SUPERAGENT_DEFAULTS.sessionPrompt

  test("硬约束放在提示词前部，先于角色与技能说明", () => {
    const constraints = prompt.indexOf("硬约束")
    expect(constraints).toBeGreaterThanOrEqual(0)
    expect(constraints).toBeLessThan(prompt.indexOf("主代理（Superagent）负责"))
    expect(prompt.indexOf("superagent-orchestration")).toBeGreaterThan(constraints)
  })

  test("默认派工、只认回执、有界核实三条都在", () => {
    expect(prompt).toContain("实现、修改、调试、测试默认派工")
    expect(prompt).toContain("小改动也派工")
    expect(prompt).toContain("派工成功只认 subagent 工具成功回执")
    expect(prompt).toContain("没收到回执不得称已派出、并行中或运行中")
    expect(prompt).toContain("失败或触到上限如实报告")
    expect(prompt).toContain("最多做一次有界只读核实")
    expect(prompt).toContain("禁止连续轮询")
  })

  test("长度受控，不重复技能里的长段", () => {
    expect(prompt.length).toBeLessThan(1200)
    expect(prompt).not.toContain("七字段")
    expect(prompt).not.toContain("L0")
  })
})

describe("报告时间口径", () => {
  test("子代理任务书要求真实时间，取不到写未知", () => {
    expect(SUPERAGENT_DEFAULTS.assignmentPrompt).toContain("报告时间取真实工具输出或通知时间")
    expect(SUPERAGENT_DEFAULTS.assignmentPrompt).toContain("取不到写「未知」")
    expect(SUPERAGENT_DEFAULTS.assignmentPrompt).toContain("不估写")
  })

  test("验收侧同样按真实时间核对", () => {
    expect(SUPERAGENT_ACCEPTANCE_SKILL.content).toContain("报告时间取真实工具输出或通知时间")
    expect(SUPERAGENT_ACCEPTANCE_SKILL.content).toContain("取不到写「未知」")
  })
})

describe("编排技能与常驻提示词同口径", () => {
  const shared = [
    "派工成功只认 subagent 工具成功回执",
    "没收到回执不得称已派出",
    "有界只读核实",
    "禁止连续轮询",
  ]

  test("硬约束以常驻提示词为准，编排技能不逐字重复", () => {
    for (const phrase of shared) expect(SUPERAGENT_DEFAULTS.sessionPrompt).toContain(phrase)
    expect(SUPERAGENT_ORCHESTRATION_SKILL.content).toContain("以常驻 sessionPrompt 为准")
    expect(SUPERAGENT_ORCHESTRATION_SKILL.content).not.toContain("派工成功只认 subagent 工具成功回执")
  })
})

describe("默认 sessionPrompt 的升级机制", () => {
  test("旧默认都留在 legacy 名单里，且与新默认不同", () => {
    expect(LEGACY_SESSION_PROMPTS.length).toBeGreaterThanOrEqual(4)
    expect(new Set(LEGACY_SESSION_PROMPTS).size).toBe(LEGACY_SESSION_PROMPTS.length)
    for (const legacy of LEGACY_SESSION_PROMPTS) {
      expect(legacy).not.toBe(SUPERAGENT_DEFAULTS.sessionPrompt)
    }
    // 上一版默认（含上下文与 compact 段）必须可识别，才能被升级。
    expect(
      LEGACY_SESSION_PROMPTS.some((text) =>
        text.includes("上下文：需要继续同一任务时优先 steer 续跑或 compact"),
      ),
    ).toBe(true)
    // 831dd95 的完整默认带有三条派工硬约束，也必须精确命中迁移。
    expect(
      LEGACY_SESSION_PROMPTS.some(
        (text) =>
          text.startsWith("硬约束：实现、修改、调试、测试默认派工") &&
          text.includes("默认上限 2 且仍受子代理总上限约束"),
      ),
    ).toBe(true)
  })

  test("条目缺失时写入新默认", async () => {
    const h = harness()
    await h.actions.initializeInstructions()
    expect(h.store.get(INSTRUCTION_KEYS.sessionPrompt)).toBe(SUPERAGENT_DEFAULTS.sessionPrompt)
  })

  test("旧默认升级为新默认", async () => {
    for (const legacy of LEGACY_SESSION_PROMPTS) {
      const h = harness({ [INSTRUCTION_KEYS.sessionPrompt]: legacy })
      await h.actions.initializeInstructions()
      expect(h.store.get(INSTRUCTION_KEYS.sessionPrompt)).toBe(SUPERAGENT_DEFAULTS.sessionPrompt)
    }
  })

  test("用户自定义提示词原样保留", async () => {
    const custom = "我自己的会话提示词：只做评审，不派工。"
    const h = harness({ [INSTRUCTION_KEYS.sessionPrompt]: custom })
    await h.actions.initializeInstructions()
    expect(h.store.get(INSTRUCTION_KEYS.sessionPrompt)).toBe(custom)
    expect(h.writes.some((write) => write.key === INSTRUCTION_KEYS.sessionPrompt)).toBe(false)
  })
})

describe("assignment 与 task 默认提示词迁移", () => {
  test("缺失条目写入新默认，task 默认留空", async () => {
    const h = harness()
    await h.actions.initializeInstructions()
    expect(h.root.assignmentPrompt).toBe(SUPERAGENT_DEFAULTS.assignmentPrompt)
    expect(h.store.get(INSTRUCTION_KEYS.taskPrompt)).toBe("")
    expect(SUPERAGENT_DEFAULTS.taskPrompt).toBe("")
  })

  test("831dd95 的 assignment 默认精确升级", async () => {
    expect(LEGACY_ASSIGNMENT_PROMPTS).toHaveLength(1)
    const h = harness()
    h.root.assignmentPrompt = LEGACY_ASSIGNMENT_PROMPTS[0]
    await h.actions.initializeInstructions()
    expect(h.root.assignmentPrompt).toBe(SUPERAGENT_DEFAULTS.assignmentPrompt)
    expect(h.root.assignmentPrompt).toContain("遇到能力升级先报告")
  })

  test("831dd95 的 task 默认与更老的空默认都升级为空白补充", async () => {
    expect(LEGACY_TASK_PROMPTS.some((text) => text.includes("按任务契约执行"))).toBe(true)
    for (const legacy of LEGACY_TASK_PROMPTS) {
      const h = harness({ [INSTRUCTION_KEYS.taskPrompt]: legacy })
      await h.actions.initializeInstructions()
      expect(h.store.get(INSTRUCTION_KEYS.taskPrompt)).toBe("")
    }
  })

  test("三项用户自定义（包括测试）都绝不覆盖", async () => {
    const custom = "测试"
    const h = harness({
      [INSTRUCTION_KEYS.sessionPrompt]: custom,
      [INSTRUCTION_KEYS.taskPrompt]: custom,
    })
    h.root.assignmentPrompt = custom
    await h.actions.initializeInstructions()
    expect(h.store.get(INSTRUCTION_KEYS.sessionPrompt)).toBe(custom)
    expect(h.store.get(INSTRUCTION_KEYS.taskPrompt)).toBe(custom)
    expect(h.root.assignmentPrompt).toBe(custom)
    expect(
      h.writes.some(
        (write) =>
          write.key === INSTRUCTION_KEYS.sessionPrompt || write.key === INSTRUCTION_KEYS.taskPrompt,
      ),
    ).toBe(false)
  })
})
