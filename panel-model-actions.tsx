/** @jsxImportSource @opentui/solid */
/**
 * 面板的模型操作：默认模型选择、全局自动模型、切换模型与子代理模型策略。
 *
 * 读取偏好/模型目录与写入设置都通过调用方注入的访问器完成；这里只保留
 * 交互流程本身与一份"正在切换"的局部集合，不引入全局可变状态。
 */

import type { Plugin } from "@opencode/plugin/tui"
import type { AgentNode } from "./agent-tree"
import { modelKey, sameModel, type ModelRef } from "./model-policy"
import { ModelPicker } from "./model-picker"
import { INSTRUCTION_KEYS } from "./panel-defaults"
import { appendOversightEvent } from "./panel-critic"
import { favoriteModels, updateModelPreference, type ModelPreference } from "./panel-preferences"
import type { DefaultAction, ModelChoice, ModelInfo } from "./panel-types"
import {
  errorText,
  isSessionRunning,
  waitForSessionIdle,
} from "./panel-utils"
import type { RootSettings } from "./session-scope"

export function createModelActions(deps: {
  context: Plugin.Context
  preferencePath: string
  preferences: () => ModelPreference
  setPreferences: (value: ModelPreference | ((current: ModelPreference) => ModelPreference)) => void
  models: () => ModelInfo[]
  autoModels: () => ModelRef[]
  names: () => Map<string, string>
  updateRoot: (mutation: (draft: RootSettings) => void) => unknown
  updateGlobal: (mutation: (draft: Record<string, any>) => void) => unknown
  rememberRecent: (model: ModelInfo) => Promise<void>
  loadPreferences: () => Promise<void>
  root: () => RootSettings
  tree: () => AgentNode | undefined
  oversightFor: (sessionID?: string) => { level: number; source: string }
  rootSessionID: () => string | undefined
  providerName: (providerID: string) => string
  pickerGroups: () => Array<{ title: string; models: ModelInfo[] }>
  pickerFavorites: () => Set<string>
  pickerKey: (model: { providerID: string; id: string }) => string
  putInstruction: (key: string, value: string | number) => Promise<unknown>
}) {
  const {
    context,
    preferencePath,
    preferences,
    setPreferences,
    models,
    autoModels,
    names,
    updateRoot,
    updateGlobal,
    rememberRecent,
    loadPreferences,
    root,
    tree,
    oversightFor,
    rootSessionID,
    providerName,
    pickerGroups,
    pickerFavorites,
    pickerKey,
    putInstruction,
  } = deps

  const policyChoice = (node: AgentNode): ModelChoice | undefined => {
    if (!node.sessionID) return undefined
    const policy = root().policies[node.sessionID] ?? root().defaultPolicy ?? "inherit"
    if (policy === "auto") return { kind: "auto" }
    if (policy === "inherit") return { kind: "inherit" }
    const actual = node.model?.actual ?? root().defaultModel
    if (!actual) return undefined
    const model = models().find((item) => item.providerID === actual.providerID && item.id === actual.id)
    return model ? { kind: "model", model } : undefined
  }

  async function toggleFavorite(model: ModelInfo) {
    const enabled = !preferences().favorite.some(
      (item) => item.providerID === model.providerID && item.modelID === model.id,
    )
    setPreferences(
      await updateModelPreference(preferencePath, (current) => ({
        favorite: favoriteModels({ providerID: model.providerID, modelID: model.id }, current.favorite, enabled),
      })),
    )
    context.ui.toast.show({ message: enabled ? `已收藏 ${model.name || model.id}。` : `已取消收藏 ${model.name || model.id}。` })
  }

  async function configureAutoModels() {
    const options = [
      ...models().map((model) => ({
        value: { kind: "toggle" as const, model },
        title: `${autoModels().some((item) => sameModel(item, model)) ? "✓" : "○"} ${model.name || model.id}`,
        description: `${model.providerID}/${model.id} · ${autoModels().some((item) => sameModel(item, model)) ? "移除" : "加入"}全局自动模型`,
      })),
      { value: { kind: "done" as const }, title: "完成", description: "所有 Session 共用这份列表" },
    ]
    if (!options.some((option) => option.value.kind === "toggle")) {
      context.ui.toast.show({ message: "当前项目没有可用模型。" })
      return
    }
    const picked = await context.ui.dialog.select<{ kind: "toggle"; model: ModelInfo } | { kind: "done" }>({
      title: "全局自动模型",
      placeholder: "选择 Superagent 可以自动分配的模型",
      options,
    })
    if (!picked || picked.kind === "done") return
    const model = picked.model
    await updateGlobal((draft) => {
      const current = (draft.autoModels ?? []) as ModelRef[]
      const exists = current.some((item) => sameModel(item, model))
      draft.autoModels = exists
        ? current.filter((item) => !sameModel(item, model))
        : [...current, { providerID: model.providerID, id: model.id }]
    })
    return configureAutoModels()
  }

  async function pickModel(title: string, current?: { providerID: string; id: string }) {
    // `ui.model.select` is the official native /models entry. OpenCode 2.2.5's
    // shipped TUI predates it, so older hosts still hit the bundled picker below.
    const native = context.ui.model?.select
    if (typeof native === "function") {
      const selected = await native({ title })
      if (!selected) return
      const info = models().find((item) => item.providerID === selected.providerID && item.id === selected.modelID)
      return {
        model: info ?? ({ providerID: selected.providerID, id: selected.modelID, name: selected.modelID } as ModelInfo),
        providerID: selected.providerID,
        id: selected.modelID,
        variant: selected.variant,
      }
    }
    await loadPreferences()
    const picked = await new Promise<ModelInfo | undefined>((resolve) => {
      let settled = false
      const done = (value: ModelInfo | undefined) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      context.ui.dialog.show(
        () => (
          <ModelPicker
            context={context}
            title={title}
            groups={pickerGroups}
            favorites={pickerFavorites}
            providerName={providerName}
            current={current}
            onFavorite={(model) => void toggleFavorite(model)}
            onSelect={(model) => {
              done(model)
              context.ui.dialog.clear()
            }}
            onClose={() => done(undefined)}
          />
        ),
        () => done(undefined),
      )
    })
    if (!picked) return
    return { model: picked, providerID: picked.providerID, id: picked.id, variant: preferences().variant[pickerKey(picked)] }
  }

  async function applyDefaultModel(model: ModelInfo, variant?: string) {
    await updateRoot((draft) => {
      draft.defaultPolicy = "fixed"
      draft.defaultModel = { providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) }
      draft.defaultSetAt = Date.now()
    })
    await putInstruction(INSTRUCTION_KEYS.defaultModel, `${model.providerID}/${model.id}`)
    await rememberRecent(model)
    context.ui.toast.show({
      message: `子代理默认模型已设为 ${model.name || model.id}，正在应用到未保护子代理。`,
    })
  }

  async function openDefaults() {
    await loadPreferences()
    const scoped = root()
    const current: DefaultAction | undefined =
      scoped.defaultPolicy === "auto"
        ? { kind: "auto" }
        : scoped.defaultPolicy === "inherit"
          ? { kind: "inherit" }
          : undefined
    const selected = await context.ui.dialog.select<DefaultAction>({
      title: "子代理默认模型",
      options: [
        {
          value: { kind: "auto" },
          title: "自动",
          description:
            autoModels().length > 0
              ? `每次分配由 Superagent 从 ${autoModels().length} 个全局自动模型中指定；不改动已有子代理`
              : "未配置（禁用）",
          disabled: autoModels().length === 0,
        },
        {
          value: { kind: "inherit" },
          title: "跟随会话",
          description: "所有未保护子代理跟随当前会话的模型（Superagent 主模型）",
        },
        {
          value: { kind: "choose" },
          title: "选择模型…",
          description: "打开原生 /models 选择器；应用到所有未保护子代理",
        },
        { value: { kind: "configure" }, title: "配置全局自动模型…", description: "所有 Session 共用这份列表" },
      ],
      current,
    })
    if (!selected) return
    if (selected.kind === "configure") return configureAutoModels()
    if (selected.kind === "auto") {
      await updateRoot((draft) => {
        draft.defaultPolicy = "auto"
        draft.defaultModel = undefined
        draft.defaultSetAt = undefined
      })
      context.ui.toast.show({ message: "子代理默认模型已设为自动。" })
      return
    }
    if (selected.kind === "inherit") {
      await updateRoot((draft) => {
        draft.defaultPolicy = "inherit"
        draft.defaultModel = undefined
        draft.defaultSetAt = undefined
      })
      context.ui.toast.show({ message: "子代理默认模型已设为跟随会话。" })
      return
    }
    const picked = await pickModel(
      "子代理默认模型",
      scoped.defaultPolicy === "fixed" ? scoped.defaultModel : undefined,
    )
    if (picked) await applyDefaultModel(picked.model, picked.variant)
  }

  /** 正在换模型的会话：同一时间只允许一次切换，避免两次动作交错。 */
  const switchingModels = new Set<string>()

  type SwitchOutcome = { running: boolean; error?: string; warn?: string }

  /**
   * 切换模型的公共流程：空闲直接换；运行中先中断并等执行真的停下，再切换，
   * 最后让子代理继续。所有失败以返回值上报，不在这里弹 toast。
   */
  async function switchModelCore(sessionID: string, model: ModelRef): Promise<SwitchOutcome> {
    const running = isSessionRunning(context, sessionID)
    if (switchingModels.has(sessionID)) return { running, error: "正在切换模型" }
    switchingModels.add(sessionID)
    try {
      if (running) {
        await context.client.session.interrupt({ sessionID })
        const stopped = await waitForSessionIdle(context, sessionID)
        if (!stopped) return { running, error: "中断没有生效" }
      }
      await context.client.session.switchModel({ sessionID, model })
      if (!running) return { running }
      try {
        await context.client.session.prompt({
          sessionID,
          text: `模型已切换为 ${names().get(modelKey(model)) ?? model.id}，继续当前任务`,
          delivery: "steer",
        })
      } catch {
        return { running, warn: "已切换模型，但未能让子代理继续" }
      }
      return { running }
    } catch (error) {
      return { running, error: errorText(error) }
    } finally {
      switchingModels.delete(sessionID)
    }
  }

  async function applyModelSwitch(sessionID: string, model: ModelRef, label: string) {
    const running = isSessionRunning(context, sessionID)
    const outcome = await switchModelCore(sessionID, model)
    if (outcome.error === "正在切换模型") {
      context.ui.toast.show({ message: "正在切换模型，请稍候。" })
      return
    }
    if (outcome.error === "中断没有生效") {
      context.ui.toast.show({ message: "中断没有生效，模型未切换。" })
      return
    }
    if (outcome.error) {
      context.ui.toast.show({ message: `切换模型失败：${outcome.error}` })
      return
    }
    if (outcome.warn) {
      context.ui.toast.show({ message: `模型已切换为 ${label}，请手动让该子代理继续。` })
      return
    }
    context.ui.toast.show({
      message: running ? `已中断当前步骤，切换模型 ${label} 并继续` : `已切换模型 ${label}`,
    })
  }

  async function openModel(node: AgentNode) {
    if (node.kind === "root") return
    // Protected Subagents keep their own model; changing it needs the protection off first.
    if (node.sessionID && root().keptSubagents?.[node.sessionID]) {
      context.ui.toast.show({
        message: `${node.title} 已受保护，模型不会被修改；请先取消保护。`,
      })
      return
    }
    await loadPreferences()
    const choice = policyChoice(node)
    const current: DefaultAction | undefined =
      choice?.kind === "auto" ? { kind: "auto" } : choice?.kind === "inherit" ? { kind: "inherit" } : undefined
    const selected = await context.ui.dialog.select<DefaultAction>({
      title: `设置 ${node.title} 的模型`,
      options: [
        {
          value: { kind: "auto" },
          title: "自动",
          description:
            autoModels().length > 0 ? `每次分配由 Superagent 从 ${autoModels().length} 个全局自动模型中指定` : "未配置（禁用）",
          disabled: autoModels().length === 0,
        },
        { value: { kind: "inherit" }, title: "跟随会话", description: "使用当前会话的模型（Superagent 主模型）" },
        { value: { kind: "choose" }, title: "选择模型…", description: "打开原生 /models 选择器" },
        { value: { kind: "configure" }, title: "配置全局自动模型…", description: "所有 Session 共用这份列表" },
      ],
      current,
    })
    if (!selected) return
    if (selected.kind === "configure") return configureAutoModels()
    if (selected.kind === "auto") {
      await updateRoot((draft) => {
        draft.policies = { ...draft.policies, [node.sessionID!]: "auto" }
      })
      context.ui.toast.show({ message: `${node.title} 已设为自动；下次分配时由 Superagent 重新选择。` })
      return
    }
    if (selected.kind === "inherit") {
      // inherit/fixed/手动选模型都不是显式旗舰委派：不做旗舰上限预检，
      // 同模型普通子代理不进入旗舰 cap。
      await updateRoot((draft) => {
        draft.policies = { ...draft.policies, [node.sessionID!]: "inherit" }
      })
      const parent = tree()?.model?.actual
      if (parent && node.sessionID)
        await applyModelSwitch(
          node.sessionID,
          {
            providerID: parent.providerID,
            id: parent.id,
            ...(parent.variant ? { variant: parent.variant } : {}),
          },
          names().get(modelKey(parent)) ?? parent.id,
        )
      return
    }
    const picked = await pickModel(`设置 ${node.title} 的模型`, node.model?.actual)
    if (!picked) return
    const modelRef = {
      providerID: picked.providerID,
      id: picked.id,
      ...(picked.variant ? { variant: picked.variant } : {}),
    }
    const oversight = oversightFor(node.sessionID!)
    await updateRoot((draft) => {
      draft.policies = { ...draft.policies, [node.sessionID!]: "fixed" }
    })
    await applyModelSwitch(node.sessionID!, modelRef, picked.model.name || picked.model.id)
    await rememberRecent(picked.model)
    void appendOversightEvent("model.changed", {
      rootSessionID: rootSessionID(),
      sessionID: node.sessionID,
      oversight: { level: oversight.level, source: oversight.source },
    }).catch(() => {})
  }

  return {
    configureAutoModels,
    openDefaults,
    openModel,
    pickModel,
    switchModelCore,
  }
}
