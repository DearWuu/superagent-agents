/**
 * 面板切换子代理模型：官方 `session.switchModel` 对运行中的会话也不中断，
 * 只作用于后续 provider 回合。手动、默认同步与旗舰降额都走同一直接切换路径。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createModelActions } from "./panel-model-actions"

const flash = { providerID: "acme", id: "flash" }
const kong = { providerID: "acme", id: "kong" }
const rootModel = { providerID: "acme", id: "root" }

const cleanups: string[] = []

function tempState() {
  const dir = mkdtempSync(path.join(tmpdir(), "manual-model-switch-"))
  cleanups.push(dir)
  process.env.XDG_STATE_HOME = dir
  process.env.SUPERAGENT_STATE_DIR = dir
  return dir
}

afterAll(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
  delete process.env.XDG_STATE_HOME
  delete process.env.SUPERAGENT_STATE_DIR
})

type HarnessOptions = {
  running?: boolean
  failSwitch?: boolean
  selections?: unknown[]
  flagship?: boolean
}

function panelHarness(options: HarnessOptions = {}) {
  const busy = options.running ?? false
  const calls: string[] = []
  const switched: Array<{ sessionID: string; model: typeof flash }> = []
  const instructionWrites: string[] = []
  const instructionRemovals: string[] = []
  const notices: Array<{ childID?: string; childTitle?: string; value: string }> = []
  const policyNotices: Array<{ policy: "auto" | "inherit" | "fixed"; value?: string }> = []
  const toasts: string[] = []
  const policies: Record<string, string> = {}
  const selections = [...(options.selections ?? [])]
  const metadata = options.flagship
    ? { "superagent.flagship": { source: "explicit-subagent-delegation", model: flash } }
    : undefined
  const sessions = new Map<string, any>([
    [
      "ses_child",
      {
        id: "ses_child",
        parentID: "root",
        model: flash,
        metadata,
        time: { created: 2, busy: busy ? 2 : undefined },
      },
    ],
  ])

  const context = {
    data: {
      session: {
        status: () => (busy ? "running" : "idle"),
        get: (sessionID: string) => sessions.get(sessionID),
        list: () => [...sessions.values()],
        message: { list: () => [] },
      },
      location: { model: { list: () => [] }, provider: { list: () => [] } },
    },
    client: {
      experimental: {
        session: {
          instructions: {
            entry: {
              list: async () => [],
              put: async ({ sessionID, key }: { sessionID: string; key: string }) => {
                instructionWrites.push(`${sessionID}:${key}`)
              },
              remove: async ({ sessionID, key }: { sessionID: string; key: string }) => {
                instructionRemovals.push(`${sessionID}:${key}`)
              },
            },
          },
        },
      },
      session: {
        interrupt: async ({ sessionID }: { sessionID: string }) => {
          calls.push(`interrupt:${sessionID}`)
        },
        switchModel: async (input: { sessionID: string; model: typeof flash }) => {
          calls.push(`switch:${input.sessionID}`)
          if (options.failSwitch) throw new Error("switch boom")
          switched.push(input)
          const session = sessions.get(input.sessionID)
          if (session) session.model = input.model
        },
        prompt: async (input: { sessionID: string; text: string; delivery?: string }) => {
          calls.push(`prompt:${input.sessionID}`)
        },
      },
    },
    keymap: { layer: () => {} },
    ui: {
      model: { select: async () => selections.shift() },
      dialog: {
        select: async () => selections.shift(),
        prompt: async () => undefined,
        clear: () => {},
        show: () => {},
        alert: async () => {},
        confirm: async () => true,
      },
      toast: { show: ({ message }: { message: string }) => toasts.push(message) },
    },
  }

  const actions = createModelActions({
    context: context as never,
    preferencePath: "",
    preferences: () => ({ favorite: [], variant: {}, recent: [] }) as never,
    setPreferences: () => {},
    models: () =>
      [
        { ...flash, name: "Flash" },
        { ...kong, name: "Kong" },
        { ...rootModel, name: "Root 模型" },
      ] as never,
    autoModels: () => [flash],
    names: () =>
      new Map([
        ["acme/root", "Root 模型"],
        ["acme/flash", "Flash"],
        ["acme/kong", "Kong"],
      ]),
    updateRoot: (mutation) => {
      const draft = {
        policies: { ...policies } as Record<string, string>,
        keptSubagents: {},
      }
      mutation(draft as never)
      Object.assign(policies, draft.policies)
      return undefined
    },
    updateGlobal: () => {},
    rememberRecent: async () => {},
    loadPreferences: async () => {},
    root: () =>
      ({
        policies,
        defaultPolicy: options.flagship ? "fixed" : "inherit",
        defaultModel: options.flagship ? kong : undefined,
        maxSubagents: 5,
        expanded: {},
        initialized: {},
        keptSubagents: {},
        assignmentPrompt: "",
        oversight: { pins: { models: {}, sessions: {} }, capabilityOverrides: {}, history: {}, lastResolved: {} },
      }) as never,
    tree: () =>
      ({
        id: "root",
        kind: "root",
        title: "root",
        status: "idle",
        model: { actual: rootModel },
        children: options.flagship
          ? [
              {
                id: "ses_child",
                kind: "subagent",
                title: "实现接口",
                status: "running",
                sessionID: "ses_child",
                model: { policy: "fixed", actual: flash },
                created: 2,
                children: [],
              },
            ]
          : [],
      }) as never,
    oversightFor: () => ({ level: 2, source: "default" }),
    rootSessionID: () => "root",
    providerName: () => "acme",
    pickerGroups: () => [],
    pickerFavorites: () => new Set(),
    pickerKey: () => "",
    putInstruction: async () => undefined,
    notifyModelChange: async (input) => {
      notices.push(input)
    },
    notifyDefaultPolicy: async (input) => {
      policyNotices.push(input)
    },
  })

  const node = {
    id: "ses_child",
    kind: "subagent" as const,
    title: "实现接口",
    status: "running" as const,
    sessionID: "ses_child",
    model: { policy: "inherit" as const, actual: flash },
    children: [],
  }

  return { actions, node, calls, switched, instructionWrites, instructionRemovals, notices, policyNotices, toasts }
}

describe("TUI 切换模型：直接 switchModel", () => {
  beforeEach(() => tempState())

  test("运行中手动 fixed：直接切换，不中断、不续跑、不写指令标记", async () => {
    const h = panelHarness({ running: true, selections: [{ kind: "choose" }, { providerID: "acme", modelID: "kong" }] })
    await h.actions.openModel(h.node as never)

    expect(h.calls).toEqual(["switch:ses_child"])
    expect(h.switched).toHaveLength(1)
    expect(h.instructionWrites).toEqual([])
    expect(h.instructionRemovals).toEqual([])
    expect(h.notices).toEqual([{ childID: "ses_child", childTitle: "实现接口", value: "Kong" }])
    const toast = h.toasts.find((item) => item.includes("已切换模型 Kong"))
    expect(toast).toContain("后续步骤使用新模型")
    expect(toast).not.toContain("中断")
  })

  test("运行中切换失败：不通知，不中断、不续跑、不写指令标记", async () => {
    const h = panelHarness({
      running: true,
      failSwitch: true,
      selections: [{ kind: "choose" }, { providerID: "acme", modelID: "kong" }],
    })
    await h.actions.openModel(h.node as never)

    expect(h.calls).toEqual(["switch:ses_child"])
    expect(h.switched).toEqual([])
    expect(h.instructionWrites).toEqual([])
    expect(h.instructionRemovals).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.toasts.some((item) => item.includes("切换模型失败"))).toBe(true)
  })

  test("空闲手动切换：直接切一次，成功后通知", async () => {
    const h = panelHarness({ selections: [{ kind: "choose" }, { providerID: "acme", modelID: "kong" }] })
    await h.actions.openModel(h.node as never)

    expect(h.calls).toEqual(["switch:ses_child"])
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]!.value).toBe("Kong")
    expect(h.toasts).toContain("已切换模型 Kong")
  })

  test("auto/inherit 只发策略通知；inherit 直接切换且失败不补发模型通知", async () => {
    const auto = panelHarness({ selections: [{ kind: "auto" }] })
    await auto.actions.openModel(auto.node as never)
    expect(auto.calls).toEqual([])
    expect(auto.notices).toEqual([])
    expect(auto.policyNotices).toEqual([{ policy: "auto" }])

    const inherit = panelHarness({ selections: [{ kind: "inherit" }] })
    await inherit.actions.openModel(inherit.node as never)
    expect(inherit.calls).toEqual(["switch:ses_child"])
    expect(inherit.switched[0]!.model).toEqual(rootModel)
    expect(inherit.notices).toEqual([])
    expect(inherit.policyNotices).toEqual([{ policy: "inherit" }])

    const failed = panelHarness({ failSwitch: true, selections: [{ kind: "inherit" }] })
    await failed.actions.openModel(failed.node as never)
    expect(failed.calls).toEqual(["switch:ses_child"])
    expect(failed.notices).toEqual([])
    expect(failed.policyNotices).toEqual([{ policy: "inherit" }])
  })

  test("共享路径：运行中的直接 switchModelCore 只切一次，无中断/续跑/标记", async () => {
    const h = panelHarness({ running: true })
    const outcome = await h.actions.switchModelCore("ses_child", kong)

    expect(outcome).toEqual({ running: true })
    expect(h.calls).toEqual(["switch:ses_child"])
    expect(h.instructionWrites).toEqual([])
    expect(h.instructionRemovals).toEqual([])
  })

  test("旗舰降额复用同一直接切换路径：运行中超额旗舰只切模型", async () => {
    const h = panelHarness({ running: true, flagship: true })
    const result = await h.actions.convergeFlagships(0)

    expect(result.switched).toBe(1)
    expect(result.failures).toEqual([])
    expect(h.calls).toEqual(["switch:ses_child"])
    expect(h.switched[0]!.model).toMatchObject({ providerID: "acme", id: "kong" })
    expect(h.instructionWrites).toEqual([])
  })
})
