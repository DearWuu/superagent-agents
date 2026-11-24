/**
 * 面板指令初始化：ready 保障与有界重试、root 切换守卫、备用限额条目对账、
 * 默认模型策略条目与子代理策略元数据对账。
 */
import { expect, test } from "bun:test"

import { INSTRUCTION_KEYS, SUPERAGENT_DEFAULTS } from "./panel-defaults"
import { createInstructionActions } from "./panel-instructions"
import { MODEL_POLICY_METADATA_KEY } from "./model-policy"
import { defaultRootSettings } from "./session-scope"

const ROOT = "root"

type HarnessOptions = {
  entries?: Record<string, unknown>
  initialized?: boolean
  defaultPolicy?: "auto" | "inherit" | "fixed"
  defaultModel?: { providerID: string; id: string; variant?: string }
  policies?: Record<string, string>
  children?: Record<string, { metadata?: Record<string, unknown> }>
  /** 每次 list 调用依次抛出这些错误；数组耗尽后正常返回。 */
  listErrors?: number
  /** 在 list 返回前把当前 root 切到该 id。 */
  switchRootDuringList?: string
}

function harness(options: HarnessOptions = {}) {
  let currentRoot = ROOT
  let values: Record<string, unknown> = { ...(options.entries ?? {}) }
  const writes: Array<{ sessionID: string; key: string; value: unknown }> = []
  const removals: Array<string> = []
  const toasts: string[] = []
  const metadataUpdates: Array<{ sessionID: string; metadata: Record<string, unknown> }> = []
  let listFailures = options.listErrors ?? 0
  const children = new Map(Object.entries(options.children ?? {}))
  const context = {
    client: {
      experimental: {
        session: {
          instructions: {
            entry: {
              list: async ({ sessionID }: { sessionID: string }) => {
                if (options.switchRootDuringList) currentRoot = options.switchRootDuringList
                if (listFailures > 0) {
                  listFailures -= 1
                  throw new Error("instructions down")
                }
                return sessionID === ROOT
                  ? Object.entries(values).map(([key, value]) => ({ key, value }))
                  : []
              },
              put: async ({ sessionID, key, value }: { sessionID: string; key: string; value: unknown }) => {
                writes.push({ sessionID, key, value })
                if (sessionID === ROOT && currentRoot === ROOT) values = { ...values, [key]: value }
              },
              remove: async ({ sessionID, key }: { sessionID: string; key: string }) => {
                removals.push(`${sessionID}:${key}`)
                if (sessionID === ROOT && currentRoot === ROOT) {
                  const next = { ...values }
                  delete next[key]
                  values = next
                }
              },
            },
          },
        },
      },
      session: {
        update: async (input: { sessionID: string; metadata: Record<string, unknown> }) => {
          metadataUpdates.push(input)
          const child = children.get(input.sessionID)
          if (child) child.metadata = input.metadata
        },
      },
    },
    data: {
      session: {
        get: (id: string) => children.get(id),
      },
    },
    ui: { toast: { show: ({ message }: { message: string }) => toasts.push(message) } },
  }
  const root = defaultRootSettings()
  root.initialized = options.initialized === false ? {} : { [ROOT]: true }
  root.defaultPolicy = options.defaultPolicy ?? "inherit"
  root.defaultModel = options.defaultModel
  root.policies = (options.policies ?? {}) as never
  let instructions: { rootID?: string; values: Record<string, unknown> } = { rootID: ROOT, values }
  const actions = createInstructionActions({
    context: context as never,
    rootSessionID: () => currentRoot,
    collabOn: () => true,
    root: () => root,
    models: () => [],
    instructionValue: (key) => (instructions.rootID === currentRoot ? instructions.values[key] : undefined),
    instructionText: (key) => {
      const value = instructions.rootID === currentRoot ? instructions.values[key] : undefined
      return typeof value === "string" ? value : typeof value === "number" ? String(value) : ""
    },
    instructionPresent: (key) => {
      const value = instructions.rootID === currentRoot ? instructions.values[key] : undefined
      return value !== undefined && value !== null && String(value).trim() !== ""
    },
    updateRoot: (mutation) => mutation(root),
    updateGlobal: () => {},
    setInstructions: ((next: never) => {
      instructions = typeof next === "function" ? (next as never)(instructions) : next
    }) as never,
    setReady: (() => {}) as never,
  })
  return { actions, root, writes, removals, toasts, metadataUpdates, values: () => values }
}

test("列表失败两次后重试成功，条目不丢也不提示", async () => {
  const h = harness({ entries: {}, listErrors: 2, initialized: false })
  await h.actions.initializeInstructions()
  expect(h.toasts).toEqual([])
  expect(h.writes.some((write) => write.key === INSTRUCTION_KEYS.sessionPrompt)).toBe(true)
  expect(h.root.initialized[ROOT]).toBe(true)
})

test("列表持续失败：ready 仍置真、只提示一次、按本地设置继续", async () => {
  const h = harness({ entries: {}, listErrors: 99 })
  await h.actions.initializeInstructions()
  expect(h.toasts).toEqual(["指令条目加载失败，已按本地设置继续"])
})

test("加载期间 root 切走：不再写入，也不标记已初始化", async () => {
  const h = harness({ entries: {}, initialized: false, switchRootDuringList: "other" })
  await h.actions.initializeInstructions()
  expect(h.writes.filter((write) => write.sessionID === ROOT)).toEqual([])
  expect(h.writes.filter((write) => write.sessionID === "other")).toEqual([])
  expect(h.root.initialized[ROOT]).toBeUndefined()
})

test("没有任何备用模型：移除限额切换的两项", async () => {
  const h = harness({
    entries: {
      [INSTRUCTION_KEYS.fallbackThreshold]: 5,
      [INSTRUCTION_KEYS.fallbackEnabled]: "false",
    },
  })
  await h.actions.initializeInstructions()
  expect(h.removals).toContain(`${ROOT}:${INSTRUCTION_KEYS.fallbackThreshold}`)
  expect(h.removals).toContain(`${ROOT}:${INSTRUCTION_KEYS.fallbackEnabled}`)
})

test("配置了备用模型：缺省的阈值与启用开关补齐", async () => {
  const h = harness({ entries: { [INSTRUCTION_KEYS.fallbackModel]: "acme/backup" } })
  await h.actions.initializeInstructions()
  const written = new Map(h.writes.map((write) => [write.key, write.value]))
  expect(written.get(INSTRUCTION_KEYS.fallbackThreshold)).toBe(SUPERAGENT_DEFAULTS.fallbackThreshold)
  expect(written.get(INSTRUCTION_KEYS.fallbackEnabled)).toBe(String(SUPERAGENT_DEFAULTS.fallbackEnabled))
})

test("固定默认模型：策略与模型条目对齐，子代理策略补写且保留其他元数据", async () => {
  const h = harness({
    defaultPolicy: "fixed",
    defaultModel: { providerID: "acme", id: "flash", variant: "high" },
    policies: { child: "fixed" },
    children: { child: { metadata: { "superagent.flagship": { at: 1 } } } },
  })
  await h.actions.initializeInstructions()
  const written = new Map(h.writes.map((write) => [write.key, write.value]))
  expect(written.get(INSTRUCTION_KEYS.defaultPolicy)).toBe("fixed")
  expect(written.get(INSTRUCTION_KEYS.defaultModel)).toBe("acme/flash#high")
  const update = h.metadataUpdates.find((item) => item.sessionID === "child")
  expect(update?.metadata).toEqual({
    "superagent.flagship": { at: 1 },
    [MODEL_POLICY_METADATA_KEY]: "fixed",
  })
})

test("跟随或自动策略：移除残留的默认模型条目", async () => {
  for (const policy of ["inherit", "auto"] as const) {
    const h = harness({ defaultPolicy: policy, entries: { [INSTRUCTION_KEYS.defaultModel]: "acme/old" } })
    await h.actions.initializeInstructions()
    expect(h.removals).toContain(`${ROOT}:${INSTRUCTION_KEYS.defaultModel}`)
    expect(h.writes.some((write) => write.key === INSTRUCTION_KEYS.defaultModel)).toBe(false)
  }
})

test("恢复默认写入 inherit 策略并清掉备用与默认模型条目", async () => {
  const h = harness({
    entries: {
      [INSTRUCTION_KEYS.fallbackModel]: "acme/backup",
      [INSTRUCTION_KEYS.defaultModel]: "acme/flash",
    },
    defaultPolicy: "fixed",
    defaultModel: { providerID: "acme", id: "flash" },
  })
  await h.actions.restoreDefaults()
  expect(h.writes.some((write) => write.key === INSTRUCTION_KEYS.defaultPolicy && write.value === "inherit")).toBe(true)
  expect(h.removals).toContain(`${ROOT}:${INSTRUCTION_KEYS.defaultModel}`)
  expect(h.removals).toContain(`${ROOT}:${INSTRUCTION_KEYS.fallbackModel}`)
})