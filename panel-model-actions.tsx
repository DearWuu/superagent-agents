/** @jsxImportSource @opentui/solid */
/**
 * 面板的模型操作：默认模型选择、全局自动模型、切换模型与子代理模型策略。
 *
 * 读取偏好/模型目录与写入设置都通过调用方注入的访问器完成；这里只保留
 * 交互流程本身与一份"正在切换"的局部集合，不引入全局可变状态。
 */

import type { Plugin } from "@opencode/plugin/tui"
import type { AgentNode } from "./agent-tree"
import { modelKey, sameModel, writeChildModelPolicy, type ModelRef } from "./model-policy"
import { pickFlagshipOverflow } from "./flagship"
import { ModelPicker } from "./model-picker"
import { INSTRUCTION_KEYS } from "./panel-defaults"
import { appendOversightEvent } from "./panel-critic"
import { favoriteModels, updateModelPreference, type ModelPreference } from "./panel-preferences"
import type { DefaultAction, ModelChoice, ModelInfo } from "./panel-types"
import { errorText, isSessionRunning } from "./panel-utils"
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
  removeInstruction: (key: string) => Promise<unknown>
  notifyModelChange: (input: { childID?: string; childTitle?: string; value: string }) => Promise<void>
  notifyDefaultPolicy: (input: { policy: "auto" | "inherit" | "fixed"; value?: string }) => Promise<void>
  notifyChildPolicy: (input: { childID: string; childTitle?: string; policy: "auto" | "inherit" | "fixed" }) => Promise<void>
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
    removeInstruction,
    notifyModelChange,
    notifyDefaultPolicy,
    notifyChildPolicy,
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
    await putInstruction(INSTRUCTION_KEYS.defaultPolicy, "fixed")
    // 条目带上 variant，与 draft.defaultModel 保持一致，服务端派工时才能复现同一选择。
    await putInstruction(
      INSTRUCTION_KEYS.defaultModel,
      `${model.providerID}/${model.id}${variant ? `#${variant}` : ""}`,
    )
    await rememberRecent(model)
    const label = model.name || model.id
    context.ui.toast.show({
      message: `子代理默认模型已设为 ${label}，正在应用到普通子代理（显式委派除外）。`,
    })
    await notifyDefaultPolicy({ policy: "fixed", value: label })
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
          description: "所有普通子代理跟随当前会话的模型（Superagent 主模型）",
        },
        {
          value: { kind: "choose" },
          title: "选择模型…",
          description: "打开原生 /models 选择器；应用到所有普通子代理（显式委派除外）",
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
      await putInstruction(INSTRUCTION_KEYS.defaultPolicy, "auto")
      await removeInstruction(INSTRUCTION_KEYS.defaultModel)
      context.ui.toast.show({ message: "子代理默认模型已设为自动。" })
      // 自动只影响下次分配，没有唯一目标：不声称现有子代理已切模型。
      await notifyDefaultPolicy({ policy: "auto" })
      return
    }
    if (selected.kind === "inherit") {
      await updateRoot((draft) => {
        draft.defaultPolicy = "inherit"
        draft.defaultModel = undefined
        draft.defaultSetAt = undefined
      })
      await putInstruction(INSTRUCTION_KEYS.defaultPolicy, "inherit")
      await removeInstruction(INSTRUCTION_KEYS.defaultModel)
      context.ui.toast.show({ message: "子代理默认模型已设为跟随会话。" })
      // 策略已保存，后续批量同步由默认模型生效流程执行。
      await notifyDefaultPolicy({ policy: "inherit" })
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

  type SwitchOutcome = { running: boolean; error?: string }

  /**
   * 切换模型的公共流程：官方 `session.switchModel` 对运行中的会话也不中断，
   * 只作用于后续 provider 回合；这里对所有会话直接切换，失败以返回值上报。
   */
  async function switchModelCore(sessionID: string, model: ModelRef): Promise<SwitchOutcome> {
    const running = isSessionRunning(context, sessionID)
    if (switchingModels.has(sessionID)) return { running, error: "正在切换模型" }
    switchingModels.add(sessionID)
    try {
      await context.client.session.switchModel({ sessionID, model })
      return { running }
    } catch (error) {
      return { running, error: errorText(error) }
    } finally {
      switchingModels.delete(sessionID)
    }
  }

  type FlagshipConvergeResult = {
    target?: ModelRef
    reason?: "auto" | "missing-target" | "unavailable-target"
    switched: number
    skipped: number
    failures: string[]
  }

  /**
   * 用户把旗舰上限调小时收敛当前 root 的超额旗舰：保留较新的 N 个，最旧的
   * 先直接切换到子代理默认模型（官方切换不中断运行中的回合）。目标只解析一次：
   * fixed 用默认模型，inherit 用当前 root 模型，auto 没有唯一目标就不猜。
   * 单项失败继续其余；身份标记由 server 在 model.selected 时清理。
   */
  async function convergeFlagships(keep: number): Promise<FlagshipConvergeResult> {
    const scoped = root()
    const policy = scoped.defaultPolicy ?? "inherit"
    const target =
      policy === "fixed" ? scoped.defaultModel : policy === "inherit" ? tree()?.model?.actual : undefined
    const candidates = (tree()?.children ?? []).flatMap((node) => {
      if (!node.sessionID) return []
      const stored = context.data.session.get(node.sessionID)
      return [
        {
          id: node.sessionID,
          title: node.title,
          model: node.model?.actual ?? stored?.model,
          metadata: stored?.metadata,
          created: node.created ?? stored?.time?.created,
        },
      ]
    })
    const overflow = pickFlagshipOverflow(candidates, keep)
    if (overflow.length === 0) return { target, switched: 0, skipped: 0, failures: [] }
    if (!target) {
      return {
        reason: policy === "auto" ? "auto" : "missing-target",
        switched: 0,
        skipped: overflow.length,
        failures: [],
      }
    }
    if (!models().some((item) => sameModel(item, target))) {
      return { target, reason: "unavailable-target", switched: 0, skipped: overflow.length, failures: [] }
    }
    let switched = 0
    const failures: string[] = []
    for (const candidate of overflow) {
      if (candidate.model && sameModel(candidate.model, target)) {
        failures.push(`${candidate.title ?? candidate.id}：已是目标模型`)
        continue
      }
      const outcome = await switchModelCore(candidate.id, {
        providerID: target.providerID,
        id: target.id,
        ...(target.variant ? { variant: target.variant } : {}),
      })
      if (outcome.error) failures.push(`${candidate.title ?? candidate.id}：${outcome.error}`)
      else switched++
    }
    return { target, switched, skipped: failures.length, failures }
  }

  /** 面板单子代理切换：直接切换并把失败以 toast 上报；返回结果供通知判定。 */
  async function applyModelSwitch(sessionID: string, model: ModelRef, label: string): Promise<SwitchOutcome> {
    const running = isSessionRunning(context, sessionID)
    const outcome = await switchModelCore(sessionID, model)
    if (outcome.error === "正在切换模型") {
      context.ui.toast.show({ message: "正在切换模型，请稍候。" })
      return outcome
    }
    if (outcome.error) {
      context.ui.toast.show({ message: `切换模型失败：${outcome.error}` })
      return outcome
    }
    context.ui.toast.show({
      message: running ? `已切换模型 ${label}，当前步骤继续，后续步骤使用新模型` : `已切换模型 ${label}`,
    })
    return outcome
  }

  async function openModel(node: AgentNode) {
    if (node.kind === "root") return
    // Protected Subagents keep their own model; changing it needs the protection off first.
    if (node.sessionID && root().keptSubagents?.[node.sessionID]) {
      context.ui.toast.show({
        message: `${node.title} 已受保护，不能手动改模型；请先取消保护（默认模型同步仍会生效）。`,
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
      await writeChildModelPolicy(context, node.sessionID!, "auto")
      context.ui.toast.show({ message: `${node.title} 已设为自动；下次分配时由 Superagent 重新选择。` })
      // 自动只表示该子代理后续分配策略，不是全局默认策略变更。
      await notifyChildPolicy({ childID: node.sessionID!, childTitle: node.title, policy: "auto" })
      return
    }
    if (selected.kind === "inherit") {
      // inherit/fixed/手动选模型都不是显式旗舰委派：不做旗舰上限预检，
      // 同模型普通子代理不进入旗舰 cap。
      await updateRoot((draft) => {
        draft.policies = { ...draft.policies, [node.sessionID!]: "inherit" }
      })
      await writeChildModelPolicy(context, node.sessionID!, "inherit")
      const parent = tree()?.model?.actual
      const label = parent ? (names().get(modelKey(parent)) ?? parent.id) : "跟随会话"
      const outcome =
        parent && node.sessionID
          ? await applyModelSwitch(
              node.sessionID,
              {
                providerID: parent.providerID,
                id: parent.id,
                ...(parent.variant ? { variant: parent.variant } : {}),
              },
              label,
            )
          : undefined
      await notifyChildPolicy({ childID: node.sessionID!, childTitle: node.title, policy: "inherit" })
      // 真实切换成功才回传模型变更；策略通知只说明该子代理后续分配。
      if (outcome && !outcome.error) {
        await notifyModelChange({ childID: node.sessionID, childTitle: node.title, value: label })
      }
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
    await writeChildModelPolicy(context, node.sessionID!, "fixed")
    const label = picked.model.name || picked.model.id
    const outcome = await applyModelSwitch(node.sessionID!, modelRef, label)
    await notifyChildPolicy({ childID: node.sessionID!, childTitle: node.title, policy: "fixed" })
    // 只有模型真的切成功才通知；失败不通知。
    if (!outcome.error) await notifyModelChange({ childID: node.sessionID, childTitle: node.title, value: label })
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
    convergeFlagships,
  }
}
