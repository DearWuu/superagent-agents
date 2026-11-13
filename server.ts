/**
 * superagent-agents —— 服务端（server）入口。
 *
 * 职责：在 `subagent` 工具执行前，按「root 家族的非归档直接子会话数 + 飞行中调用数」
 * 做硬上限拦截。TUI 右栏（./tui）里的上限只是提示词层的软约束，这里是硬约束：
 * 超限时在工具执行前抛错，子会话不会被创建。
 *
 * 判定口径：
 *  - root：沿 parentID 逐级上溯到没有 parentID 的会话；
 *  - 存在数：root 的非归档直接子会话数；
 *  - 在途数：本 root 上还没跑完的 subagent 调用数（含本次调用自己占的那一个槽）。
 *    本次调用要占的槽就是它在途里的这一份，判定与淘汰都不再另加一份，
 *    所以放行条件是 `存在数 + 在途数 <= 上限`——放行后共存的子代理不会超过上限；
 *  - 上限：caller 沿父链遇到的第一个带 `superagent.*` 指令条目的会话上的
 *    `superagent.max-subagents`（缺省 5，非法值回退 5）；
 *  - steer（input.sessionID 非空）：续跑已有子会话，不占新槽，直接放行；
 *  - 超限：先淘汰「已结束、不在运行中、不是正在被 steer、也不在保护名单」里最旧的
 *    子会话；这类候选不够时，再兜底淘汰「开了工却没收尾、且已经僵死超过阈值」的
 *    僵尸子会话（记 stale-evict）；仍超限才拒绝。查询异常一律放行（fail-open）。
 *
 * 与 TUI 侧（./tui）的差异：
 *  - TUI 存着「保护 / 当前查看」这类编排状态，server 端读不到，
 *    所以保护名单通过 root 链上的 `superagent.kept-subagents` 指令条目传递：
 *    条目值是逗号分隔的 sessionID 列表，命中即跳过淘汰；条目不存在即无保护。
 *  - TUI 的上限读的是指令条目 + TUI 存储，server 端只能读指令条目。
 *
 * 限额备用模型：
 *  - 限额类错误（RateLimit / 429 / quota / 余额不足文本）开始计时：来源是 `session.retry`
 *    钩子与 `session.execution.failed` 事件（宿主没触发 retry 钩子时也能计时）；
 *    首次限额失败开始 60 秒窗口（`FALLBACK_TIMEOUT_MS`），
 *    窗口内任一成功恢复就取消；窗口到期仍未恢复且已启用
 *    （`superagent.fallback-enabled`，缺省 true）时，经 `ctx.session.switchModel` 切到
 *    root 的 `superagent.fallback-model`、子会话的 `superagent.subagent-fallback-model`；
 *    每个 session 只自动切一次，切完不回切。到点切换失败最多再试一次。
 *  - 成功信号（`session.step.ended` / `session.execution.succeeded`）取消计时；
 *    步骤失败（`session.step.ended` 且 `finish=error`）不取消；
 *    中断、非限额失败与会话删除放弃计时。
 *  - 切换触发时把 root 的 `superagent.max-subagents` 降一档（5→4→3→2，下限 2），
 *    由常量 `QUOTA_TIER_DOWN` 控制；不自动恢复。
 *
 * 旗舰子代理（只认显式委派）：
 *  - 新 root key `superagent.max-flagship-subagents`（默认 2，合法 0..20，非法回退 2，
 *    实际再受 `superagent.max-subagents` 总上限约束）；旗舰 = Superagent 通过原生
 *    subagent 工具在 `input.model` 里显式指定与 root 相同 provider/model/variant 的委派。
 *  - 只有显式 `input.model` 与 root 同模型才按旗舰准入（新建与 steer 同一规则）；
 *    缺省 input、agent.model、parent 继承、inherit/固定默认模型、UI/F2/手动
 *    switchModel 都不创建旗舰身份、不占旗舰槽。旗舰超限先淘汰最旧已完成旗舰，
 *    运行中/steer/保护名单不删，无可淘汰则明确拒绝。
 *  - 旗舰身份只认 child 自身 `metadata["superagent.flagship"] =
 *    { model, at, source: "explicit-subagent-delegation" }`：
 *    `tool:execute.after` 成功（status=completed）时按 `event.result.metadata.sessionID`
 *    （或 steer 目标）写入标记，失败不写；`session.model.selected` 只在已有标记因
 *    child 切走模型而失效时清理，不因切到 parent 同模型而新增；root 切模型不清洗旧
 *    child 标记。无该 source 的旧标记一律按普通子代理处理。
 *
 * 显式模型委派标记：
 *  - 任何非空 `input.model` 的新建调用在 `session.created` 时即写 child 自身
 *    `superagent.model-delegation = { model, at, source: "explicit-subagent-model" }`，
 *    `execute.after` 成功后再补写；steer 只在成功后落到目标会话。新建按父会话/
 *    标题/模型匹配唯一待处理调用，面板默认模型同步无需等工具结束。该标记独立于
 *    旗舰标记，只记录模型由调用方显式指定；非旗舰模型同样写。
 *  - TUI 默认模型批量同步（fixed/inherit）跳过该标记有效且 child 当前模型仍与
 *    标记一致的子代理；标记缺失、来源不符或模型已切走时不保护。默认模型只作用于
 *    未显式指定模型的子代理。
 *
 * 保护子会话的模型硬约束：
 *  - 命中保护名单（`superagent.kept-subagents`）的子会话，steer 到它时模型也不可改：
 *    显式 `input.model`、或切换 agent 时 `agent.model` 带来的模型变化都被拒绝（ToolError，
 *    提示先取消保护）；同模型续跑、未指定模型且不换 agent 的普通 steer 照常放行。
 *  - 限额备用切换同样跳过保护中的会话：不计失败、不切模型、不强制重试（记 `fallback-kept-model`）。
 *  - 保护名单读不到时按无保护处理（fail-open）并记 `kept-read-failed`。
 *  - TUI 直接调 `session.switchModel` 的路径不在这里拦截，也不做模型回滚。
 *
 * 子代理复核（critic）：
 *  - 监听 `session.execution.succeeded`；只有 root 的 `superagent.critic-enabled`
 *    为真、且完成的是「root 家族里的非 root、非 critic 子会话」时才复核；
 *    `superagent.oversight-level`（child 优先，其次 root，默认 L2）为 L4 时强制复核。
 *  - 复核在后台异步跑（`critic.ts`），失败只记日志，绝不影响会话主流程；
 *    结果写 critic 审计 JSONL，另外在 hook.log 留一条 `critic-finished`。
 *  - 同一完成事件可能被多个插件实例收到（reload 后旧订阅未必及时释放），
 *    用 `critic-claims/` 下的落盘声明保证只有一个实例真正复核。
 *
 * 超时状态探针：
 *  - 每 5 分钟扫一次会话列表，凡带 `superagent.*` 指令条目的 root 家族里，
 *    有 `time.busy`、没有 `time.idle` 与 outcome、且已运行满 30 分钟的子会话
 *    （与 TUI `LONG_RUNNING_THRESHOLD_MS` 同语义），发一条 steer 探针要一行状态。
 *  - 每个子会话只探一次（`probe-claims/` 落盘声明，跨插件实例同样只发一次）；
 *    critic 会话与 root 自身跳过。
 *
 * 超长上下文自动压缩（与面板 ctx 读数同口径）：
 *  - 复用同一个 5 分钟扫描周期：对带 `superagent.*` 指令条目的 root 家族里的子会话，
 *    取其最近一次 assistant 调用的输入 token 数（input + cache 读写，跳过 compact 之前的旧记录）。
 *  - 阈值复用 `context-policy.ts`：有模型窗口时 `min(300K, floor(window * 0.8))`，
 *    否则 300K；窗口经 `session.model` + `ctx.model.list` 的 `limit.context` 读取并缓存，
 *    查询失败回退 300K。严格超过阈值就直接对该 **子会话** 调用原生 `ctx.session.compact`
 *    （与手动点「压缩上下文」同一操作：保持当前模型、不发提示词；
 *    compact 请求本身产生的压缩消息是预期行为）。
 *  - 每个子会话只自动压缩一次（`ctx-claims/` 落盘声明，记着上次压缩时的 token 数）；
 *    若当前长度较上次压缩下降 ≥30%（compact 已生效），清掉声明，允许再次压缩。
 *  - 该 root 的协作总开关关闭、critic 会话、root 自身、已结束的子会话都跳过；压缩失败只记日志。
 */


import { Schema } from "effect"

import { criticReview, lastAssistantText } from "./critic"
import { isFlagshipSession } from "./flagship"
import {
  effectiveFlagshipLimit,
  flagshipDenyMessage,
  flagshipFormula,
  isFlagshipModel,
  isFlagshipOverLimit,
  normalizeFlagshipModel,
  pickFlagshipVictim,
  readMaxFlagshipSubagents,
} from "./flagship-admission"
import { normalizeModelDelegationModel, sameModelDelegationModel } from "./model-delegation"
import { DEFAULT_OVERSIGHT_LEVEL } from "./oversight"
import {
  createCtxContextCompactionScanner,
  createCtxProbeScanner,
  startProbeTimer,
} from "./server-scanners"
import {
  createQuotaFallback,
  denyMessage,
  FALLBACK_TIMEOUT_MS,
  forceRetryAfterSwitch,
  isQuotaFailure,
  readOversightLevel,
  shouldCriticReview,
  type ModelRef,
} from "./server-models"
import {
  classifyEvictFailure,
  clearRuntimeState,
  collabEnabledForSession,
  detectSteerModelChange,
  eventData,
  findRoot,
  handleSessionModelSelected,
  isOverLimit,
  keptModelDenyMessage,
  listChildren,
  markFlagshipSession,
  markModelDelegationSession,
  markRuntimeBackground,
  pickVictim,
  readAgentInfo,
  readKeptSubagents,
  readKeptSubagentsSafe,
  readLimit,
  readRootCollabEnabled,
  readSessionModel,
  toChild,
} from "./server-session"
import {
  DEFAULT_MAX_SUBAGENTS,
  DenyError,
  MAX_SUBAGENTS_KEY,
  PLUGIN_ID,
  QUOTA_TIER_DOWN,
  TOOL_NAME,
  asArray,
  claimCriticReview,
  collabEnabledFromEntries,
  errorText,
  eventSessionID,
  isObject,
  log,
  pruneClaims,
} from "./server-state"
import { SUPERAGENT_SKILLS } from "./skills"
import {
  DISPATCH_LEDGER_LIMIT,
  SHELL_SETTLE_DELAY_MS,
  STATUS_RECONCILE_INTERVAL_MS,
  attachDispatchReceipt,
  createDispatchLedger,
  createStatusWatcher,
  formatDispatchReceipt,
  type CompletionState,
  type DispatchLedger,
  type DispatchPatch,
} from "./subagent-status"

export {
  CRITIC_ENABLED_KEY,
  CONTEXT_DROP_RATIO,
  CONTEXT_WARN_TOKENS,
  DEFAULT_LOG_FILE,
  FALLBACK_RETRY_DELAY_MS,
  OVERSIGHT_LEVEL_KEY,
  PROBE_AFTER_MS,
  PROBE_INTERVAL_MS,
  PROBE_TEXT,
  QUOTA_LIMIT_FLOOR,
  QUOTA_TIER_DOWN,
  STALE_AFTER_MS,
  clearContextClaim,
  claimContextCompaction,
  claimCriticReview,
  claimProbe,
  collabEnabledFromEntries,
  COLLAB_ENABLED_KEY,
  contextClaimFile,
  contextDropped,
  eventSessionID,
  log,
  logFile,
  readCollabState,
  readContextClaim,
  stateRoot,
} from "./server-state"
export type { Child, CollabSwitchState } from "./server-state"
export type { ModelRef } from "./server-models"
export type { FallbackConfig } from "./server-models"
export {
  createModelContextWindowLookup,
  createCtxCompactionScanner,
  createCtxContextCompactionScanner,
  createCtxProbeScanner,
  createProbeScanner,
  contextTokens,
  isContextOverLimit,
  shouldCheckContext,
  shouldProbe,
  startProbeTimer,
  toProbeCandidate,
} from "./server-scanners"
export type { CtxCompactionScannerDeps, ProbeCandidate, ProbeScannerDeps } from "./server-scanners"
export {
  classifyEvictFailure,
  detectSteerModelChange,
  handleSessionModelSelected,
  isOverLimit,
  keptModelDenyMessage,
  listChildren,
  markFlagshipSession,
  markModelDelegationSession,
  parseKeptSubagents,
  pickVictim,
  toChild,
} from "./server-session"
export {
  createQuotaFallback,
  denyMessage,
  downgradeLimit,
  forceRetryAfterSwitch,
  formatModelRef,
  isEnabledValue,
  isQuotaFailure,
  parseModelRef,
  readCriticEnabled,
  readFallbackConfig,
  readMaxSubagents,
  readOversightLevel,
  resolveOversightLevel,
  shouldCriticReview,
} from "./server-models"
export type { QuotaFallbackDeps, RetryFailure } from "./server-models"

/**
 * 随插件注册原生 Skills：用 `ctx.skill.transform` 一次性加入静态流程资产。
 * 已存在同名技能（id 相同）不覆盖；任何失败只记 `skills-register-failed`，不阻断 setup。
 */
export async function registerSuperagentSkills(ctx: any, write: (record: Record<string, unknown>) => void = log) {
  if (typeof ctx?.skill?.transform !== "function") return undefined
  try {
    const registration = await ctx.skill.transform((editor: any) => {
      for (const skill of SUPERAGENT_SKILLS) {
        try {
          if (typeof editor?.get === "function" && editor.get(skill.id)) continue
          editor.add({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            path: skill.path,
            content: skill.content,
          })
        } catch (cause) {
          write({
            event: "skills-register-failed",
            decision: "error",
            skill: skill.id,
            cause: errorText(cause),
          })
        }
      }
    })
    write({ event: "skills-registered", decision: "allow", count: SUPERAGENT_SKILLS.length })
    return registration
  } catch (cause) {
    write({ event: "skills-register-failed", decision: "error", cause: errorText(cause) })
    return undefined
  }
}

/** 续跑前中断的默认等待上限与轮询间隔；与 TUI 换模型时的空闲等待同量级。 */
export const SUBAGENT_INTERRUPT_TIMEOUT_MS = 10_000
export const SUBAGENT_INTERRUPT_POLL_MS = 50

/** 对账周期：默认 60s；`SUPERAGENT_STATUS_RECONCILE_MS` 只用于测试与排查。 */
function reconcileIntervalMs() {
  const raw = Number(process.env.SUPERAGENT_STATUS_RECONCILE_MS)
  return Number.isFinite(raw) && raw >= 50 ? raw : STATUS_RECONCILE_INTERVAL_MS
}

/** 限额备用模型的计时窗口（毫秒）：默认 60s；`SUPERAGENT_FALLBACK_TIMEOUT_MS` 只用于测试与排查。 */
function fallbackTimeoutMs() {
  const raw = Number(process.env.SUPERAGENT_FALLBACK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 10 ? raw : FALLBACK_TIMEOUT_MS
}

const SUBAGENT_INTERRUPT_DESCRIPTION =
  "续跑已有子代理时默认排队，不打断当前运行；只有显式 true 才先中断并等待停止。设为 false 与缺省行为相同。"

function abortError(signal?: AbortSignal) {
  const reason = signal?.reason
  if (reason instanceof Error && reason.name !== "AbortError") return reason
  if (reason instanceof Error) return new Error(`续跑投递已取消：${reason.message}`)
  return new Error(reason === undefined ? "续跑投递已取消" : `续跑投递已取消：${String(reason)}`)
}

function sleepWithSignal(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const done = () => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(abortError(signal))
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export type SubagentInterruptDeps = {
  getSession: (sessionID: string) => Promise<unknown>
  interrupt: (sessionID: string) => Promise<unknown>
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  timeoutMs?: number
  pollMs?: number
}

type SubagentInterruptOutcome = "idle" | "interrupted"

/**
 * 对已有子会话做一次“先停后投递”的前置检查。返回 idle 表示无需中断；
 * interrupted 表示已中断且确认停止。读取、中断或等待失败都明确抛错。
 */
export async function interruptBeforeSubagentSteer(
  deps: SubagentInterruptDeps,
  sessionID: string,
  signal?: AbortSignal,
): Promise<SubagentInterruptOutcome> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? sleepWithSignal
  const timeoutMs = deps.timeoutMs ?? SUBAGENT_INTERRUPT_TIMEOUT_MS
  const pollMs = deps.pollMs ?? SUBAGENT_INTERRUPT_POLL_MS

  const running = async () => {
    try {
      const raw: any = await deps.getSession(sessionID)
      const item = isObject(raw) && isObject(raw.data) ? raw.data : raw
      if (!isObject(item)) throw new Error("会话不存在或返回为空")
      return toChild(item, now()).running
    } catch (cause) {
      if (signal?.aborted) throw abortError(signal)
      throw new Error(`读取子会话 ${sessionID} 状态失败：${errorText(cause)}`)
    }
  }

  if (signal?.aborted) throw abortError(signal)
  if (!(await running())) return "idle"
  if (signal?.aborted) throw abortError(signal)
  if (typeof deps.interrupt !== "function") {
    throw new Error(`中断子会话 ${sessionID} 失败：宿主不支持 session.interrupt`)
  }
  try {
    await deps.interrupt(sessionID)
  } catch (cause) {
    if (signal?.aborted) throw abortError(signal)
    throw new Error(`中断子会话 ${sessionID} 失败：${errorText(cause)}`)
  }
  if (signal?.aborted) throw abortError(signal)

  const deadline = now() + timeoutMs
  for (;;) {
    if (signal?.aborted) throw abortError(signal)
    if (!(await running())) {
      if (signal?.aborted) throw abortError(signal)
      return "interrupted"
    }
    const remaining = deadline - now()
    if (remaining <= 0) {
      throw new Error(`中断子会话 ${sessionID} 后等待停止超时（${timeoutMs}ms）`)
    }
    await sleep(Math.min(pollMs, remaining), signal)
  }
}

/** 原生 subagent 的工具输入：只关心续跑目标、interrupt 开关与后台标记。 */
function subagentInput(input: unknown): {
  sessionID?: string
  interrupt?: unknown
  background: boolean
  native: unknown
} {
  if (!isObject(input)) return { background: false, native: input }
  const sessionID = typeof input.sessionID === "string" && input.sessionID.length > 0 ? input.sessionID : undefined
  const background = input.background === true
  const { interrupt, ...native } = input
  return { sessionID, interrupt, background, native }
}

/** 派发成功后回调：让宿主接线登记看护项。 */
export type SubagentDispatchHook = (input: {
  callID?: string
  childID: string
  parentID?: string
  description: string
  agent: string
  background: boolean
  state: string
}) => Promise<void> | void

/**
 * 包装原生 subagent 执行：续跑默认排队不抢占，直接把去掉 interrupt 的原生输入
 * 交给宿主（原生 steer 自己排队）；只有显式 interrupt:true 才先中断并等待目标
 * 真正停止再投递。新建与 idle 不额外查询。
 *
 * 派发台账（ledger）在这里落定：中断结果、子会话 ID、后台标记与耗时都会写进去，
 * 回执也挂到工具结果上，让 Superagent 当场看到这次派发发生了什么。
 */
export async function executeSubagentWithInterrupt(
  ctx: any,
  execute: (input: any, context: any) => Promise<any>,
  input: unknown,
  context: any,
  ledger?: DispatchLedger,
  onDispatch?: SubagentDispatchHook,
) {
  const parsed = subagentInput(input)
  const callID = typeof context?.id === "string" ? context.id : undefined
  const patch = (value: DispatchPatch) => {
    if (callID) ledger?.update(callID, value)
  }
  const started = Date.now()
  // 调用已取消：不查询、不中断、不投递。
  if (context?.signal?.aborted) throw abortError(context.signal)
  if (parsed.sessionID) {
    if (parsed.interrupt !== true) {
      // 默认排队：不抢占当前运行，交给原生 steer 排队投递。
      patch({ interrupt: "off" })
    } else {
      let outcome: SubagentInterruptOutcome
      try {
        outcome = await interruptBeforeSubagentSteer(
          {
            getSession: (sessionID) => ctx.session.get({ sessionID }),
            interrupt: (sessionID) => ctx.session.interrupt({ sessionID }),
          },
          parsed.sessionID,
          context?.signal,
        )
      } catch (cause) {
        patch({ interrupt: "failed" })
        if (callID) ledger?.warn(callID, `中断失败：${errorText(cause)}`)
        log({
          event: "status-dispatch",
          decision: "error",
          callID: callID ?? null,
          childSessionID: parsed.sessionID,
          interrupt: "failed",
          cause: errorText(cause),
        })
        throw cause
      }
      if (outcome === "interrupted") {
        log({
          event: "subagent-interrupt",
          decision: "allow",
          childSessionID: parsed.sessionID,
          elapsedMs: Date.now() - started,
        })
        patch({ interrupt: "interrupted" })
      } else {
        patch({ interrupt: "not-needed" })
      }
    }
  }
  const result = await execute(parsed.native, context)
  const metadata = isObject(result?.metadata) ? result.metadata : {}
  const childID =
    typeof metadata.sessionID === "string" && metadata.sessionID ? metadata.sessionID : parsed.sessionID
  const background = parsed.background || metadata.status === "running"
  const state = typeof metadata.status === "string" ? metadata.status : background ? "running" : "completed"
  patch({ childID, background, state, elapsedMs: Date.now() - started })
  const record = callID ? ledger?.peek(callID) : undefined
  if (record) {
    attachDispatchReceipt(result, formatDispatchReceipt(record, { ok: true, state }))
    log({
      event: "status-dispatch",
      decision: "allow",
      callID: record.callID,
      mode: record.mode,
      childSessionID: childID ?? null,
      parentID: record.parentID,
      state,
      interrupt: record.interrupt,
      background,
      evicted: record.evicted,
      warnings: record.warnings,
      elapsedMs: record.elapsedMs ?? null,
    })
  }
  if (childID && onDispatch) {
    const nativeInput = isObject(parsed.native) ? parsed.native : {}
    try {
      await onDispatch({
        callID,
        childID,
        parentID: typeof context?.sessionID === "string" ? context.sessionID : undefined,
        description: typeof nativeInput.description === "string" ? nativeInput.description : "",
        agent: typeof nativeInput.agent === "string" ? nativeInput.agent : "",
        background,
        state,
      })
    } catch (cause) {
      log({
        event: "status-notify-failed",
        decision: "error",
        phase: "dispatch",
        childSessionID: childID,
        cause: errorText(cause),
      })
    }
  }
  return result
}

function hasSubagentInterruptField(input: any) {
  const fields = input?.fields
  if (isObject(fields)) return Object.prototype.hasOwnProperty.call(fields, "interrupt")
  if (isObject(input) && input.type === "object" && isObject(input.properties)) {
    return Object.prototype.hasOwnProperty.call(input.properties, "interrupt")
  }
  return false
}

/** 给原生 subagent schema 追加可选 interrupt；返回 undefined 表示无法安全扩展。 */
function withSubagentInterruptField(input: any) {
  const fields = input?.fields
  if (isObject(fields)) {
    if (hasSubagentInterruptField(input)) return input
    if (typeof input.pipe !== "function" || typeof Schema.fieldsAssign !== "function") return undefined
    return input.pipe(
      Schema.fieldsAssign({
        interrupt: Schema.optional(Schema.Boolean).annotate({ description: SUBAGENT_INTERRUPT_DESCRIPTION }),
      }),
    )
  }
  if (isObject(input) && input.type === "object" && isObject(input.properties)) {
    if (hasSubagentInterruptField(input)) return input
    return {
      ...input,
      properties: {
        ...input.properties,
        interrupt: { type: "boolean", description: SUBAGENT_INTERRUPT_DESCRIPTION },
      },
    }
  }
  return undefined
}

const wrappedSubagentExecutes = new WeakSet<Function>()

/**
 * 注册原生 subagent 的 schema 扩展与执行包装。schema 无法扩展时不包装：
 * 此时宿主可能已剥离未知的 interrupt 字段，继续包装会误判调用方的意图。
 */
export async function registerSubagentInterrupt(
  ctx: any,
  ledger?: DispatchLedger,
  write: (record: Record<string, unknown>) => void = log,
  onDispatch?: SubagentDispatchHook,
) {
  if (typeof ctx?.tool?.transform !== "function") return undefined
  try {
    const registration = await ctx.tool.transform((editor: any) => {
      try {
        const tool = typeof editor?.get === "function" ? editor.get(TOOL_NAME) : undefined
        if (!tool) {
          write({
            event: "subagent-interrupt-skip",
            decision: "allow",
            note: "原生 subagent 工具不存在，未注册",
          })
          return
        }
        editor.update(TOOL_NAME, (mutable: any) => {
          const alreadyExtended = hasSubagentInterruptField(mutable.input)
          const extended = withSubagentInterruptField(mutable.input)
          if (extended === undefined) {
            write({
              event: "subagent-interrupt-unavailable",
              decision: "error",
              note: "原生 subagent schema 无法追加 interrupt，保留原生 steer，不包装执行",
            })
            return
          }
          mutable.input = extended
          if (!alreadyExtended) {
            write({
              event: "subagent-interrupt-schema-extended",
              decision: "allow",
              note: "原生 subagent schema 已追加 interrupt",
            })
          }
          const execute = mutable.execute
          if (typeof execute !== "function") {
            write({
              event: "subagent-interrupt-wrap-failed",
              decision: "error",
              note: "原生 subagent 没有可包装的 execute",
            })
            return
          }
          if (wrappedSubagentExecutes.has(execute)) return
          const wrapped = (input: any, context: any) =>
            executeSubagentWithInterrupt(ctx, execute, input, context, ledger, onDispatch)
          wrappedSubagentExecutes.add(wrapped)
          mutable.execute = wrapped
        })
      } catch (cause) {
        write({ event: "subagent-interrupt-register-failed", decision: "error", cause: errorText(cause) })
      }
    })
    write({ event: "subagent-interrupt-registered", decision: "allow" })
    return registration
  } catch (cause) {
    write({ event: "subagent-interrupt-register-failed", decision: "error", cause: errorText(cause) })
    return undefined
  }
}

export default {
  id: PLUGIN_ID,
  async setup(ctx: any) {
    // 宿主把 `@opencode/plugin/*` 作为运行时模块提供；拿不到就退回普通 Error
    // （promise adapter 会把普通 Error 包成 Tool.Error，message 保留）。
    let ToolError: any = null
    try {
      const mod: any = await import("@opencode/plugin/promise/tool")
      ToolError = typeof mod?.Error === "function" ? mod.Error : null
    } catch {
      ToolError = null
    }

    // 原生 Skills 是静态流程资产，注册与协作总开关无关；失败只记日志。
    const skillRegistration = await registerSuperagentSkills(ctx)

    /* ---------------- 状态回传：台账、看护、通知与对账 ---------------- */

    /** 派发台账：回执、告警与中断结果都按 callID 记在这里。 */
    const ledger = createDispatchLedger(DISPATCH_LEDGER_LIMIT)

    /** 看护器：登记子代理、完成/后台通知与周期对账都在这里。 */
    const watcher = createStatusWatcher({
      readSession: async (sessionID) => ctx.session.get({ sessionID }),
      readMessages: async (sessionID) => asArray(await ctx.session.context({ sessionID })),
      readEntries: async (sessionID) => asArray(await ctx.session.instructions.entry.list({ sessionID })),
      notifyParent: async (input) => {
        if (typeof ctx.session?.synthetic !== "function") throw new Error("宿主不支持 session.synthetic")
        await ctx.session.synthetic(input)
      },
      markRuntime: async (sessionID, background) => {
        await markRuntimeBackground(ctx, { sessionID, background })
      },
      clearRuntime: async (sessionID) => {
        await clearRuntimeState(ctx, sessionID)
      },
      write: log,
      reconcileIntervalMs: reconcileIntervalMs(),
    })

    /** 派发成功后的接线：登记看护项并触发第一次收尾检查。 */
    const onDispatch: SubagentDispatchHook = async (input) => {
      if (!input.childID || !input.parentID) return
      const record = input.callID ? ledger.peek(input.callID) : undefined
      let rootID = record?.rootID
      if (!rootID) {
        try {
          rootID = await findRoot(ctx, input.parentID)
        } catch {
          rootID = undefined
        }
      }
      await watcher.register({
        childID: input.childID,
        parentID: input.parentID,
        rootID,
        description: record?.description || input.description,
        agent: record?.agent || input.agent,
        background: input.background,
      })
    }

    // 续跑默认排队不抢占；只有显式 interrupt:true 才先中断。schema 无法扩展时不包装。
    const interruptRegistration = await registerSubagentInterrupt(ctx, ledger, log, onDispatch)

    /** callID → 本次调用的登记信息；flagshipRoot/flagshipModel 记本次占的显式旗舰槽。 */
    const pending = new Map<
      string,
      {
        rootID?: string
        steerTarget?: string
        flagshipRoot?: string
        flagshipModel?: unknown
        delegatedModel?: unknown
        callerSessionID?: string
        delegatedTitle?: string
      }
    >()
    /** root → 飞行中（子会话尚未创建）的 subagent 调用数。 */
    const flying = new Map<string, number>()
    /** root → 飞行中的旗舰 subagent 调用数（含本次调用自己的槽）。 */
    const flyingFlagship = new Map<string, number>()
    /** 正在被 steer 的子会话：淘汰时避开。 */
    const steered = new Set<string>()

    /** 限额备用模型：首次限额失败开始计时，窗口内恢复就取消，每会话只切一次。 */
    const quotaFallback = createQuotaFallback({
      switchModel: async ({ sessionID, model }) => {
        await ctx.session.switchModel({ sessionID, model })
      },
      writeLimit: async ({ sessionID, limit }) => {
        await ctx.session.instructions.entry.put({ sessionID, key: MAX_SUBAGENTS_KEY, value: limit })
      },
      log,
      tierDown: QUOTA_TIER_DOWN,
      timeoutMs: fallbackTimeoutMs(),
      // 到点再确认一次：协作停用或会话受保护都不切。
      canSwitch: async ({ sessionID, rootID }) => {
        if (!(await readRootCollabEnabled(ctx, rootID))) return false
        const kept = await readKeptSubagentsSafe(ctx, sessionID, rootID, { sessionID })
        if (kept?.has(sessionID)) return false
        return true
      },
      // 到点时读最新配置：期间用户可能改了开关或备用模型。
      readEntries: async ({ rootID }) => asArray(await ctx.session.instructions.entry.list({ sessionID: rootID })),
    })

    /** critic.ts 认的 client：消息列表在顶层 `message.list`，V2 里由 `session.context` 提供。 */
    const criticClient = {
      session: {
        create: (input: any) => ctx.session.create(input),
        get: (input: any) => ctx.session.get(input),
        update: (input: any) => ctx.session.update(input),
        prompt: (input: any) => ctx.session.prompt(input),
        remove: (input: any) => ctx.session.remove(input),
      },
      message: {
        list: (input: any) => ctx.session.context({ sessionID: input.sessionID }),
      },
    }
    /** 同一子会话的复核不并发；review 仍然每次成功完成各做一次。 */
    const criticInFlight = new Set<string>()

    /** 子会话成功完成后的后台复核；任何异常都只进日志，不影响主流程。 */
    const reviewAfterSuccess = async (sessionID: string, claimID?: string) => {
      if (criticInFlight.has(sessionID)) return
      criticInFlight.add(sessionID)
      try {
        const child = await ctx.session.get({ sessionID })
        const rootID = await findRoot(ctx, sessionID)
        let rootEntries: any[] = []
        let rootReadFailed = false
        try {
          rootEntries = asArray(await ctx.session.instructions.entry.list({ sessionID: rootID }))
        } catch (cause) {
          rootReadFailed = true
          log({
            event: "collab-read-failed",
            decision: "allow",
            root: rootID,
            note: "开关读取失败，按启用处理；critic 读取失败保持关闭",
            cause: errorText(cause),
          })
        }
        // 总开关按 root 生效：本 root 停用时不发复核，L4 也不能越过总开关。
        if (!collabEnabledFromEntries(rootEntries)) return
        let childEntries: any[] = []
        let childReadFailed = false
        try {
          childEntries = asArray(await ctx.session.instructions.entry.list({ sessionID }))
        } catch (cause) {
          childReadFailed = true
          log({
            event: "oversight-child-read-failed",
            decision: "allow",
            childSessionID: sessionID,
            root: rootID,
            note: "子会话监管等级读取失败，按 root 等级处理",
            cause: errorText(cause),
          })
        }
        const childLevel = readOversightLevel(childEntries)
        const rootLevel = readOversightLevel(rootEntries)
        const level = childLevel ?? rootLevel ?? DEFAULT_OVERSIGHT_LEVEL
        log({
          event: "critic-level",
          decision: "allow",
          childSessionID: sessionID,
          root: rootID,
          childLevel: childLevel ?? null,
          rootLevel: rootLevel ?? null,
          level,
          childReadFailed,
          rootReadFailed,
        })
        // root 条目读失败时无法确认监管等级：保持 fail-closed，不凭 L4 触发复核。
        if (
          !shouldCriticReview({
            eventType: "session.execution.succeeded",
            childSessionID: sessionID,
            rootID,
            child,
            entries: rootEntries,
            oversightLevel: rootReadFailed ? undefined : level,
          })
        ) {
          return
        }
        // 同一完成事件可能被多个插件实例收到（reload 后旧订阅未必及时释放），
        // 在判定通过后用落盘声明保证只有一个实例真正复核。
        if (!claimCriticReview(claimID)) {
          log({ event: "critic-skip-duplicate", decision: "allow", childSessionID: sessionID, root: rootID, claim: claimID })
          return
        }
        const reportText = lastAssistantText(asArray(await ctx.session.context({ sessionID })))
        const result = await criticReview({ client: criticClient, childSessionID: sessionID, rootID, reportText }, { log })
        log({ event: "critic-finished", decision: "allow", childSessionID: sessionID, root: rootID, verdict: result.verdict })
      } catch (cause) {
        log({ event: "critic-hook-error", decision: "error", childSessionID: sessionID, cause: errorText(cause) })
      } finally {
        criticInFlight.delete(sessionID)
      }
    }

    const bump = (rootID: string, delta: number) => {
      const next = (flying.get(rootID) ?? 0) + delta
      if (next <= 0) flying.delete(rootID)
      else flying.set(rootID, next)
    }

    const bumpFlagship = (rootID: string, delta: number) => {
      const next = (flyingFlagship.get(rootID) ?? 0) + delta
      if (next <= 0) flyingFlagship.delete(rootID)
      else flyingFlagship.set(rootID, next)
    }

    const before = await ctx.tool.hook("execute.before", async (event: any) => {
      // 快路径：不是 subagent 立即返回，不做任何查询。
      if (event?.tool !== TOOL_NAME) return
      // 总开关按 root 生效：本 root 停用时直接放行，steer 登记等副作用也不发生。
      const callerSessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
      if (!(await collabEnabledForSession(ctx, callerSessionID))) return
      const input = isObject(event.input) ? event.input : undefined
      const steerTarget =
        typeof input?.sessionID === "string" && input.sessionID.length > 0 ? input.sessionID : undefined
      const base = { sessionID: event.sessionID, callID: event.id, agent: event.agent }
      const explicitModel =
        typeof input?.model === "string" && input.model.trim() !== "" ? input.model : undefined
      // 任何显式 input.model 都登记到本次调用：成功后写独立于旗舰的委派标记。
      const delegatedModel = normalizeModelDelegationModel(explicitModel)
      // 派发台账：协作开启的调用才登记，回执也只对登记过的调用生效。
      ledger.begin(event.id, {
        parentID: event.sessionID,
        description: typeof input?.description === "string" ? input.description : "",
        agent: typeof input?.agent === "string" ? input.agent : typeof event.agent === "string" ? event.agent : "",
        model: explicitModel,
        mode: steerTarget ? "steer" : "new",
        decision: "allowed",
        background: input?.background === true,
      })
      let reserved: string | undefined
      let reservedFlagship: string | undefined

      /** 归还本次调用占的槽（总槽与旗舰槽），before 拒绝或异常时用。 */
      const releaseReservation = () => {
        const entry = pending.get(event.id)
        pending.delete(event.id)
        const root = reserved ?? entry?.rootID
        if (root) bump(root, -1)
        const flagRoot = reservedFlagship ?? entry?.flagshipRoot
        if (flagRoot) bumpFlagship(flagRoot, -1)
        reserved = undefined
        reservedFlagship = undefined
      }
      const reserveFlagship = (rootID: string, model: unknown) => {
        bumpFlagship(rootID, 1)
        reservedFlagship = rootID
        const entry = pending.get(event.id)
        if (entry) {
          entry.flagshipRoot = rootID
          entry.flagshipModel = model
        } else pending.set(event.id, { flagshipRoot: rootID, flagshipModel: model })
      }

      try {
        if (steerTarget) {
          // 续跑已有子会话：不占新的总槽。显式 `input.model` 升级成旗舰才占旗舰槽。
          pending.set(event.id, { steerTarget, delegatedModel, callerSessionID })
          steered.add(steerTarget)
          let steerRoot: string | undefined
          let targetFlagship = false
          let alreadyFlagship = false
          let flagLimit: number | undefined
          let flagExist = 0
          let flagInflight = 0
          let flagEvicted = 0
          const evictedIds: string[] = []
          try {
            steerRoot = await findRoot(ctx, steerTarget)
            const target = await ctx.session.get({ sessionID: steerTarget })
            const targetModel = isObject(target) ? target.model : undefined
            const rootModel = await readSessionModel(ctx, steerRoot)
            const agent = await readAgentInfo(ctx, input?.agent)
            const switched = isObject(target) && agent ? target.agent !== agent.id : false
            // 保护中的子会话：模型也不可改。显式 model、或切换 agent 带来的模型变化都要拦；
            // 同模型续跑与不换 agent 的普通 steer 照常放行。
            const keptForSteer = await readKeptSubagentsSafe(ctx, event.sessionID, steerRoot, base)
            if (keptForSteer?.has(steerTarget)) {
              const change = detectSteerModelChange({
                explicitModel: explicitModel,
                agentModel: agent?.model,
                switched,
                existingModel: targetModel,
              })
              if (change) {
                const message = keptModelDenyMessage({
                  sessionID: steerTarget,
                  from: change.from,
                  to: change.to,
                })
                releaseReservation()
                steered.delete(steerTarget)
                log({
                  event: "kept-model-denied",
                  decision: "deny",
                  reason: "kept-model-locked",
                  root: steerRoot,
                  steerTarget,
                  from: change.from ?? null,
                  to: change.to ?? null,
                  message,
                  ...base,
                })
                ledger.update(event.id, { decision: "denied", reason: "kept-model-locked" })
                throw new DenyError(message)
              }
            }
            // 旗舰准入只认显式 `input.model` 与 root 同模型：agent 切换或原模型
            // 恰与 root 相同的普通续跑不占旗舰槽、不写旗舰身份。
            const explicitRef = normalizeFlagshipModel(explicitModel)
            targetFlagship = explicitRef ? isFlagshipModel(explicitRef, rootModel) : false
            alreadyFlagship = isObject(target)
              ? isFlagshipSession(
                  { model: target.model, metadata: isObject(target.metadata) ? target.metadata : undefined },
                  rootModel,
                )
              : false
            if (targetFlagship && !alreadyFlagship) {
              // 已旗舰的 steer 不重复计数；显式升级成旗舰才占新旗舰槽。
              reserveFlagship(steerRoot, explicitRef)
              const found = await readLimit(ctx, event.sessionID, steerRoot)
              flagLimit = effectiveFlagshipLimit(readMaxFlagshipSubagents(found.entries), found.limit)
              let children = await listChildren(ctx, steerRoot, Date.now())
              const existOf = () => children.filter((child) => isFlagshipSession(child, rootModel)).length
              const inflightOf = () => flyingFlagship.get(steerRoot!) ?? 0
              flagExist = existOf()
              flagInflight = inflightOf()
              if (isFlagshipOverLimit(flagExist, flagInflight, flagLimit)) {
                let kept: Set<string> | undefined
                try {
                  kept = await readKeptSubagents(ctx, event.sessionID, steerRoot)
                } catch (cause) {
                  log({
                    event: "kept-read-failed",
                    decision: "allow",
                    root: steerRoot,
                    note: "保护名单读取失败，旗舰 switch 放行不淘汰",
                    cause: errorText(cause),
                    ...base,
                  })
                }
                if (kept) {
                  for (;;) {
                    flagExist = existOf()
                    flagInflight = inflightOf()
                    if (!isFlagshipOverLimit(flagExist, flagInflight, flagLimit)) break
                    const roundFormula = flagshipFormula(flagExist, flagInflight, flagLimit)
                    const flagships = children.filter((child) => isFlagshipSession(child, rootModel))
                    const victim = pickFlagshipVictim(flagships, steered, kept)
                    if (!victim) break
                    try {
                      await ctx.session.remove({ sessionID: victim.id })
                    } catch (cause) {
                      const verdict = await classifyEvictFailure(ctx, steerRoot!, victim.id, Date.now())
                      if (verdict.status === "concurrent") {
                        children = verdict.children
                        log({
                          event: "evict-concurrent",
                          decision: "allow",
                          root: steerRoot,
                          victim: victim.id,
                          reason: "steer-switch",
                          formula: roundFormula,
                          cause: errorText(cause),
                          ...base,
                        })
                        continue
                      }
                      log({
                        event: "flagship-evict-failed",
                        decision: "error",
                        root: steerRoot,
                        victim: victim.id,
                        formula: roundFormula,
                        cause: errorText(cause),
                        refreshCause: verdict.status === "refresh-failed" ? errorText(verdict.cause) : undefined,
                        ...base,
                      })
                      break
                    }
                    flagEvicted++
                    evictedIds.push(victim.id)
                    log({
                      event: "flagship-evict",
                      decision: "allow",
                      root: steerRoot,
                      victim: victim.id,
                      reason: "steer-switch",
                      count: flagExist + flagInflight,
                      exist: flagExist,
                      inflight: flagInflight,
                      evicted: flagEvicted,
                      limit: flagLimit,
                      formula: roundFormula,
                      ...base,
                    })
                    children = await listChildren(ctx, steerRoot, Date.now())
                  }
                }
              }
              flagExist = existOf()
              flagInflight = inflightOf()
              if (isFlagshipOverLimit(flagExist, flagInflight, flagLimit)) {
                releaseReservation()
                steered.delete(steerTarget)
                const message = flagshipDenyMessage({
                  count: flagExist + flagInflight,
                  limit: flagLimit,
                  rootID: steerRoot,
                })
                log({
                  event: "subagent-denied",
                  decision: "deny",
                  reason: "flagship-limit",
                  root: steerRoot,
                  count: flagExist + flagInflight,
                  exist: flagExist,
                  inflight: flagInflight,
                  evicted: flagEvicted,
                  limit: null,
                  limitSource: null,
                  flagshipExist: flagExist,
                  flagshipInflight: flagInflight,
                  flagshipLimit: flagLimit,
                  evictedIds,
                  formula: `steer=no-slot ${flagshipFormula(flagExist, flagInflight, flagLimit)}`,
                  message,
                  ...base,
                })
                ledger.update(event.id, { decision: "denied", reason: "flagship-limit" })
                throw new DenyError(message)
              }
            }
          } catch (cause) {
            if (cause instanceof DenyError) throw cause
            // 预测失败不阻断 steer（fail-open）；已占的旗舰槽要还回去。
            if (reservedFlagship) {
              steered.delete(steerTarget)
              releaseReservation()
            }
            log({
              event: "flagship-steer-skip",
              decision: "allow",
              root: steerRoot ?? null,
              note: "旗舰判定失败，按普通 steer 放行",
              steerTarget,
              cause: errorText(cause),
              ...base,
            })
          }
          if (steerRoot) ledger.update(event.id, { rootID: steerRoot })
          ledger.update(event.id, { evicted: evictedIds })
          log({
            event: "subagent-steer",
            decision: "allow",
            root: steerRoot ?? null,
            count: null,
            exist: null,
            inflight: null,
            evicted: flagEvicted,
            limit: null,
            formula: "steer=no-slot",
            steerTarget,
            flagship: targetFlagship,
            alreadyFlagship,
            flagshipExist: targetFlagship && !alreadyFlagship ? flagExist : null,
            flagshipInflight: targetFlagship && !alreadyFlagship ? flagInflight : null,
            flagshipLimit: targetFlagship && !alreadyFlagship ? (flagLimit ?? null) : null,
            flagshipFormula:
              targetFlagship && !alreadyFlagship && flagLimit !== undefined
                ? flagshipFormula(flagExist, flagInflight, flagLimit)
                : null,
            evictedIds,
            ...base,
          })
          return
        }

        const now = Date.now()
        let rootID = event.sessionID
        let limit = DEFAULT_MAX_SUBAGENTS
        let limitSource: string | undefined
        let configEntries: any[] | undefined
        let children: Child[] = []
        let rootModel: unknown
        let predictedFlagship = false
        let flagLimit: number | undefined
        try {
          rootID = await findRoot(ctx, event.sessionID)
          ledger.update(event.id, { rootID })
          // 先占槽再看子会话：并发调用必须互相看见，否则会同时放行、超发。
          bump(rootID, 1)
          reserved = rootID
          pending.set(event.id, {
            rootID,
            delegatedModel,
            callerSessionID,
            delegatedTitle:
              typeof input?.description === "string" && input.description.trim() !== ""
                ? input.description
                : undefined,
          })
          const found = await readLimit(ctx, event.sessionID, rootID)
          limit = found.limit
          limitSource = found.source
          configEntries = found.entries
          children = await listChildren(ctx, rootID, now)
          // 旗舰准入只认显式 `input.model` 与 root 同模型：缺省 input、agent 默认
          // 模型、parent 继承都是普通子代理，不占旗舰槽、不写旗舰身份。
          rootModel = await readSessionModel(ctx, rootID)
          const explicitRef = normalizeFlagshipModel(explicitModel)
          predictedFlagship = explicitRef ? isFlagshipModel(explicitRef, rootModel) : false
          if (predictedFlagship) {
            reserveFlagship(rootID, explicitRef)
            flagLimit = effectiveFlagshipLimit(readMaxFlagshipSubagents(configEntries), limit)
          }
        } catch (cause) {
          // 查询异常：fail-open，放行并留 error 日志。已占的槽要还回去。
          const inflightAtFailure = reserved ? (flying.get(reserved) ?? 0) : 0
          releaseReservation()
          log({
            event: "lookup-failed",
            decision: "error",
            root: rootID,
            count: null,
            exist: null,
            inflight: inflightAtFailure,
            evicted: 0,
            limit,
            formula: `exist=? inflight=${inflightAtFailure} total=? limit=${limit}`,
            cause: errorText(cause),
            ...base,
          })
          // fail-open 不是静默的：回执里带上告警，模型能看见这次判定没查成。
          ledger.warn(event.id, `查询失败，已放行：${errorText(cause)}`)
          return
        }

        // 存在数 = 已有的非归档直接子会话；在途数 = 本 root 上还在飞的调用（含本次）。
        // 本次调用占的那个槽就是它在途里的这一份，判定与淘汰都不再另加一份，
        // 因此放行条件是 `存在数 + 在途数 <= 上限`。
        const inflight = () => flying.get(rootID) ?? 0
        let exist = children.length
        let count = exist + inflight()
        let evicted = 0
        const evictedIds: string[] = []
        const flagshipExist = () => children.filter((child) => isFlagshipSession(child, rootModel)).length
        const needsFlagshipEviction = () =>
          predictedFlagship &&
          flagLimit !== undefined &&
          isFlagshipOverLimit(flagshipExist(), flyingFlagship.get(rootID) ?? 0, flagLimit)
        let kept: Set<string> | undefined

        if (isOverLimit(exist, inflight(), limit) || needsFlagshipEviction()) {
          // 淘汰前先读保护名单：root 链上的 `superagent.kept-subagents`。
          try {
            kept = await readKeptSubagents(ctx, event.sessionID, rootID)
          } catch (cause) {
            // 读不到保护名单就不动数据：fail-open 放行本次调用。
            log({
              event: "kept-read-failed",
              decision: "allow",
              root: rootID,
              count,
              exist,
              inflight: inflight(),
              evicted: 0,
              limit,
              formula: `exist=${exist} inflight=${inflight()} total=${count} limit=${limit}`,
              cause: errorText(cause),
              ...base,
            })
            ledger.warn(event.id, `保护名单读取失败，已放行：${errorText(cause)}`)
            return
          }
        }

        if (isOverLimit(exist, inflight(), limit)) {
          const protectedIDs = kept ?? new Set<string>()
          for (;;) {
            // 每轮都重新算一次：并发调用可能已经结束，槽位已经还回来了。
            count = exist + inflight()
            if (!isOverLimit(exist, inflight(), limit)) break
            const roundFormula = `exist=${exist} inflight=${inflight()} total=${count} limit=${limit}`
            const victim = pickVictim(children, steered, protectedIDs)
            if (!victim) break
            const victimID = victim.child.id
            try {
              await ctx.session.remove({ sessionID: victimID })
            } catch (cause) {
              // 两个并发调用可能选中同一个 victim：先删成功的不会报错，后到的
              // 收到 NotFound。此时刷新列表确认 victim 已消失，按并发移除处理并
              // 重新计算，而不是把本次调用拒掉。
              const verdict = await classifyEvictFailure(ctx, rootID, victimID, now)
              if (verdict.status === "concurrent") {
                children = verdict.children
                exist = children.length
                log({
                  event: "evict-concurrent",
                  decision: "allow",
                  root: rootID,
                  victim: victimID,
                  reason: victim.reason,
                  exist,
                  inflight: inflight(),
                  limit,
                  formula: roundFormula,
                  cause: errorText(cause),
                  ...base,
                })
                continue
              }
              log({
                event: "evict-failed",
                decision: "error",
                root: rootID,
                count,
                exist,
                inflight: inflight(),
                limit,
                victim: victimID,
                formula: roundFormula,
                cause: errorText(cause),
                refreshCause: verdict.status === "refresh-failed" ? errorText(verdict.cause) : undefined,
                ...base,
              })
              break
            }
            evicted++
            evictedIds.push(victimID)
            log({
              event: victim.reason === "stale-evict" ? "stale-evict" : "subagent-evict",
              decision: "allow",
              root: rootID,
              victim: victimID,
              reason: victim.reason,
              count,
              exist,
              inflight: inflight(),
              evicted,
              limit,
              formula: roundFormula,
              ...base,
            })
            children = await listChildren(ctx, rootID, now)
            exist = children.length
          }
        }

        // 旗舰上限独立于总上限：优先淘汰最旧已完成旗舰；运行中/steer/保护的都不动。
        let flagshipEvicted = 0
        if (predictedFlagship && flagLimit !== undefined) {
          const protectedIDs = kept ?? new Set<string>()
          for (;;) {
            const flagExist = flagshipExist()
            const flagInflight = flyingFlagship.get(rootID) ?? 0
            if (!isFlagshipOverLimit(flagExist, flagInflight, flagLimit)) break
            const roundFormula = flagshipFormula(flagExist, flagInflight, flagLimit)
            const flagships = children.filter((child) => isFlagshipSession(child, rootModel))
            const victim = pickFlagshipVictim(flagships, steered, protectedIDs)
            if (!victim) break
            try {
              await ctx.session.remove({ sessionID: victim.id })
            } catch (cause) {
              const verdict = await classifyEvictFailure(ctx, rootID, victim.id, now)
              if (verdict.status === "concurrent") {
                children = verdict.children
                exist = children.length
                log({
                  event: "evict-concurrent",
                  decision: "allow",
                  root: rootID,
                  victim: victim.id,
                  reason: "flagship-limit",
                  exist,
                  inflight: inflight(),
                  limit,
                  formula: roundFormula,
                  cause: errorText(cause),
                  ...base,
                })
                continue
              }
              log({
                event: "flagship-evict-failed",
                decision: "error",
                root: rootID,
                victim: victim.id,
                formula: roundFormula,
                cause: errorText(cause),
                refreshCause: verdict.status === "refresh-failed" ? errorText(verdict.cause) : undefined,
                ...base,
              })
              break
            }
            flagshipEvicted++
            evicted++
            evictedIds.push(victim.id)
            log({
              event: "flagship-evict",
              decision: "allow",
              root: rootID,
              victim: victim.id,
              reason: "flagship-limit",
              count: flagExist + flagInflight,
              exist: flagExist,
              inflight: flagInflight,
              evicted: flagshipEvicted,
              limit: flagLimit,
              formula: roundFormula,
              ...base,
            })
            children = await listChildren(ctx, rootID, now)
            exist = children.length
          }
        }

        // 判定快照：拒绝时槽位要还回去，日志按判定时刻的算式记。
        const decision = { count: exist + inflight(), exist, inflight: inflight() }
        const formula = `exist=${decision.exist} inflight=${decision.inflight} total=${decision.count} limit=${limit}`
        const flagExist = predictedFlagship ? flagshipExist() : undefined
        const flagInflight = predictedFlagship ? (flyingFlagship.get(rootID) ?? 0) : undefined
        const flagFormula =
          predictedFlagship && flagLimit !== undefined
            ? flagshipFormula(flagExist ?? 0, flagInflight ?? 0, flagLimit)
            : undefined
        const flagshipFields = predictedFlagship
          ? {
              flagship: true,
              flagshipExist: flagExist,
              flagshipInflight: flagInflight,
              flagshipLimit: flagLimit,
              flagshipEvicted,
              flagshipFormula: flagFormula,
            }
          : { flagship: false }

        if (isOverLimit(decision.exist, decision.inflight, limit)) {
          // 拒绝：被拒绝的调用不会触发 execute.after，槽位要在这里还回去。
          releaseReservation()
          const message = denyMessage(decision.count, limit, rootID)
          log({
            event: "subagent-denied",
            decision: "deny",
            reason: "total-limit",
            root: rootID,
            ...decision,
            evicted,
            limit,
            limitSource,
            evictedIds,
            children: children.map((child) => child.id),
            formula,
            message,
            ...flagshipFields,
            ...base,
          })
          ledger.update(event.id, { decision: "denied", reason: "total-limit" })
          throw new DenyError(message)
        }

        if (
          predictedFlagship &&
          flagLimit !== undefined &&
          isFlagshipOverLimit(flagExist ?? 0, flagInflight ?? 0, flagLimit)
        ) {
          // 旗舰槽不够且没有可淘汰的已完成旗舰：明确拒绝，不静默超发。
          releaseReservation()
          const message = flagshipDenyMessage({
            count: (flagExist ?? 0) + (flagInflight ?? 0),
            limit: flagLimit,
            rootID,
          })
          log({
            event: "subagent-denied",
            decision: "deny",
            reason: "flagship-limit",
            root: rootID,
            ...decision,
            evicted,
            limit,
            limitSource,
            evictedIds,
            children: children.map((child) => child.id),
            formula: `${formula} ${flagFormula ?? ""}`.trim(),
            message,
            ...flagshipFields,
            ...base,
          })
          ledger.update(event.id, { decision: "denied", reason: "flagship-limit" })
          throw new DenyError(message)
        }

        ledger.update(event.id, { evicted: evictedIds })
        log({
          event: "subagent-allowed",
          decision: "allow",
          root: rootID,
          ...decision,
          evicted,
          limit,
          limitSource,
          evictedIds,
          children: children.map((child) => child.id),
          formula: `${formula} ${flagFormula ?? ""}`.trim(),
          ...flagshipFields,
          ...base,
        })
      } catch (cause) {
        if (cause instanceof DenyError) {
          releaseReservation()
          if (ToolError) throw new ToolError({ message: cause.message })
          throw cause
        }
        // 意外异常：fail-open，不能把用户的 subagent 调用打挂。
        if (steerTarget) steered.delete(steerTarget)
        releaseReservation()
        log({
          event: "hook-error",
          decision: "error",
          root: null,
          count: null,
          limit: null,
          cause: errorText(cause),
          ...base,
        })
        // fail-open 不是静默的：回执里带上告警，模型能看见这次判定没查成。
        ledger.warn(event.id, `插件判定异常，已放行：${errorText(cause)}`)
      }
    })

    /** 原生 subagent 成功输出的子会话 ID：优先 `result.metadata.sessionID`。 */
    const resultSessionID = (event: any): string | undefined => {
      if (event?.status !== "completed" || !isObject(event.result)) return undefined
      const metadata = isObject(event.result.metadata) ? event.result.metadata : {}
      if (typeof metadata.sessionID === "string" && metadata.sessionID) return metadata.sessionID
      if (typeof event.result.sessionID === "string" && event.result.sessionID) return event.result.sessionID
      return undefined
    }

    const after = await ctx.tool.hook("execute.after", async (event: any) => {
      if (event?.tool !== TOOL_NAME) return
      let entry:
        | {
            rootID?: string
            steerTarget?: string
            flagshipRoot?: string
            flagshipModel?: unknown
            delegatedModel?: unknown
            callerSessionID?: string
          }
        | undefined
      try {
        entry = pending.get(event.id)
        if (!entry) return
        pending.delete(event.id)
        if (entry.rootID) bump(entry.rootID, -1)
        if (entry.flagshipRoot) bumpFlagship(entry.flagshipRoot, -1)
        if (entry.steerTarget) steered.delete(entry.steerTarget)
      } catch {
        // after 钩子抛错会波及工具体本身，这里绝不能抛。
        return
      }
      // 显式委派标记只在 status=completed 的成功调用后写（steer 失败也不写）。
      // 新建从 result.metadata.sessionID 取 child，steer 落到目标会话。
      if (!entry.flagshipModel && !entry.delegatedModel) return
      const root = entry.rootID ?? entry.flagshipRoot ?? null
      const childSessionID = event?.status === "completed" ? resultSessionID(event) ?? entry.steerTarget : undefined
      if (!childSessionID) {
        if (entry.flagshipModel) {
          log({
            event: "flagship-mark-skip",
            decision: "allow",
            root: entry.flagshipRoot ?? null,
            callID: event.id,
            note:
              event?.status === "completed"
                ? "无 result.metadata.sessionID，不写旗舰标记"
                : "status!=completed，不写旗舰标记",
          })
        }
        if (entry.delegatedModel) {
          log({
            event: "model-delegation-mark-skip",
            decision: "allow",
            root,
            steerTarget: entry.steerTarget ?? null,
            callID: event.id,
            note:
              event?.status === "completed"
                ? "无 result.metadata.sessionID，不写显式模型委派标记"
                : "status!=completed，不写显式模型委派标记",
          })
        }
        return
      }
      if (entry.flagshipModel) {
        try {
          await markFlagshipSession(ctx, {
            sessionID: childSessionID,
            parentID: entry.flagshipRoot,
            model: entry.flagshipModel,
          })
        } catch (cause) {
          log({
            event: "flagship-mark-failed",
            decision: "error",
            root: entry.flagshipRoot ?? null,
            childSessionID,
            cause: errorText(cause),
          })
        }
      }
      if (entry.delegatedModel) {
        try {
          await markModelDelegationSession(ctx, {
            sessionID: childSessionID,
            parentID: entry.callerSessionID,
            model: entry.delegatedModel,
          })
        } catch (cause) {
          log({
            event: "model-delegation-mark-failed",
            decision: "error",
            root,
            childSessionID,
            cause: errorText(cause),
          })
        }
      }
    })

    /**
     * `session.created` 时提前写显式委派标记：新建子会话一出现就带上标记，
     * 面板的默认模型同步无需等 `execute.after`。只匹配父会话、标题与模型都一致
     * 的单个待处理调用；多个候选时不猜，留给 after 逐个补写。
     */
    const markDelegationOnSessionCreated = async (event: any) => {
      const data = eventData(event)
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
      const parentID = typeof data.parentID === "string" ? data.parentID : undefined
      if (!sessionID || !parentID) return
      if (!normalizeModelDelegationModel(data.model)) return
      const title = typeof data.title === "string" ? data.title : undefined
      const candidates = [...pending.entries()].filter(
        ([, entry]) =>
          entry.delegatedModel !== undefined &&
          !entry.steerTarget &&
          entry.callerSessionID === parentID &&
          sameModelDelegationModel(entry.delegatedModel, data.model) &&
          (entry.delegatedTitle === undefined || title === entry.delegatedTitle),
      )
      if (candidates.length === 0) return
      if (candidates.length > 1) {
        log({
          event: "model-delegation-mark-skip",
          decision: "allow",
          phase: "created",
          sessionID,
          parentID,
          callIDs: candidates.map(([callID]) => callID),
          note: "多个待处理显式委派匹配同一新建子会话，留给 execute.after",
        })
        return
      }
      const callID = candidates[0]![0]
      try {
        await markModelDelegationSession(ctx, {
          sessionID,
          parentID,
          model: data.model,
          metadata: isObject(data.metadata) ? data.metadata : undefined,
          phase: "created",
        })
      } catch (cause) {
        log({
          event: "model-delegation-mark-failed",
          decision: "error",
          phase: "created",
          callID,
          sessionID,
          parentID,
          cause: errorText(cause),
        })
      }
    }

    /**
     * 触发一次限额备用计时：读 root、协作开关、保护名单与配置条目，
     * 再交给状态机判断（首次失败 arm 计时，已有计时只更新快照）。
     * retry 钩子与 `session.execution.failed` 走同一条路，
     * 保证宿主没触发 retry 钩子时限额失败同样计入 60 秒窗口。
     */
    const triggerQuotaFallback = async (
      sessionID: string,
      error: unknown,
      model?: unknown,
      attempt?: number,
    ): Promise<{ switched: boolean; to?: ModelRef }> => {
      const rootID = await findRoot(ctx, sessionID)
      // 总开关按 root 生效：本 root 停用时不计时、不切模型。
      if (!(await readRootCollabEnabled(ctx, rootID))) return { switched: false }
      // 保护中的子会话不参与限额备用切换：不计时、不切模型、不强制重试。
      const keptForFallback = await readKeptSubagentsSafe(ctx, sessionID, rootID, { sessionID })
      if (keptForFallback?.has(sessionID)) {
        log({
          event: "fallback-kept-model",
          decision: "allow",
          root: rootID,
          sessionID,
          note: "受保护子会话：限额失败不计时、不切模型、不强制重试",
        })
        return { switched: false }
      }
      const entries = asArray(await ctx.session.instructions.entry.list({ sessionID: rootID }))
      return quotaFallback.onFailure({
        sessionID,
        rootID,
        isRoot: sessionID === rootID,
        error,
        model,
        entries,
        attempt,
      })
    }

    // 限额重试：core 在每次重试决策前触发 retry 钩子。首次限额失败只开始计时，
    // 不当场切模型；窗口到期仍未恢复才切（此时没有决策可翻，只有同步到期路径会翻）。
    // 钩子里的异常一律吞掉。
    const retry = await ctx.session.hook("retry", async (event: any) => {
      try {
        if (!isQuotaFailure(event?.error)) return
        const sessionID = typeof event?.sessionID === "string" ? event.sessionID : undefined
        if (!sessionID) return
        const outcome = await triggerQuotaFallback(
          sessionID,
          event.error,
          event.model,
          typeof event?.attempt === "number" ? event.attempt : undefined,
        )
        forceRetryAfterSwitch(event, outcome.switched)
      } catch (cause) {
        log({
          event: "fallback-hook-error",
          decision: "error",
          root: null,
          count: null,
          limit: null,
          sessionID: event?.sessionID,
          cause: errorText(cause),
        })
      }
    })

    // 成功即清零：step 成功（单次 LLM 调用成功）或整个执行成功都算。
    // 同一事件流顺带触发子会话复核：复核本身在后台跑，不阻塞消费循环。
    const resetAbort = new AbortController()
    const resetSubscription = (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [
            "session.created",
            "session.step.ended",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.shell.started",
            "session.shell.ended",
            "session.model.selected",
            "session.deleted",
          ],
          signal: resetAbort.signal,
        })) {
          if (event?.type === "session.created") {
            try {
              await markDelegationOnSessionCreated(event)
            } catch (cause) {
              log({
                event: "model-delegation-mark-failed",
                decision: "error",
                phase: "created",
                type: event.type,
                childSessionID: eventSessionID(event),
                cause: errorText(cause),
              })
            }
            continue
          }
          if (event?.type === "session.model.selected") {
            try {
              await handleSessionModelSelected(ctx, event)
            } catch (cause) {
              log({
                event: "flagship-marker-failed",
                decision: "error",
                type: event.type,
                childSessionID: eventSessionID(event),
                cause: errorText(cause),
              })
            }
            continue
          }
          // 状态回传：子会话结束与 shell 起止只驱动看护项，不参与限额计时。
          const watchedID = eventSessionID(event)
          if (
            watchedID &&
            (event?.type === "session.execution.succeeded" ||
              event?.type === "session.execution.failed" ||
              event?.type === "session.execution.interrupted" ||
              event?.type === "session.shell.started" ||
              event?.type === "session.shell.ended")
          ) {
            if (event.type === "session.shell.ended") {
              watcher.settle(watchedID, { delayMs: SHELL_SETTLE_DELAY_MS })
            } else if (event.type === "session.shell.started") {
              watcher.settle(watchedID)
            } else {
              const state: CompletionState =
                event.type === "session.execution.failed"
                  ? "error"
                  : event.type === "session.execution.interrupted"
                    ? "cancelled"
                    : "completed"
              watcher.settle(watchedID, { state })
            }
          }
          const sessionID = eventSessionID(event)
          if (!sessionID) continue
          // 限额备用：成功即取消计时；中断与会话删除放弃计时；
          // 限额失败保留计时（窗口内没恢复才切）；其他失败同样放弃。
          if (event?.type === "session.execution.succeeded") {
            quotaFallback.reset(sessionID)
          } else if (event?.type === "session.step.ended") {
            // 只有 error 表示步骤失败：其余取值（stop/length/tool-calls/content-filter/unknown）
            // 以及缺省都说明模型已返回，即已恢复，取消计时。
            // 若把非 error 也当失败，限额失败那一步的 step.ended 会把刚起的计时取消掉。
            const finish = eventData(event)?.finish
            if (finish !== "error") {
              quotaFallback.reset(sessionID)
            }
          } else if (event?.type === "session.execution.interrupted" || event?.type === "session.deleted") {
            quotaFallback.cancel(sessionID)
          } else if (event?.type === "session.execution.failed") {
            const failure = eventData(event)?.error
            if (isQuotaFailure(failure)) {
              // 宿主可能没触发 retry 钩子（例如限额错误被判为不重试）：
              // 失败事件走同一条路，同样启动 60 秒计时；已有计时只更新快照。
              let model: unknown
              try {
                model = (await ctx.session.get({ sessionID }))?.model
              } catch {
                model = undefined
              }
              try {
                await triggerQuotaFallback(sessionID, failure, model)
              } catch (cause) {
                log({
                  event: "fallback-hook-error",
                  decision: "error",
                  phase: "execution-failed",
                  root: null,
                  count: null,
                  limit: null,
                  sessionID,
                  cause: errorText(cause),
                })
              }
            } else {
              quotaFallback.cancel(sessionID)
            }
          }
          // 复核在内部按该会话所属 root 的开关短路。
          if (event?.type === "session.execution.succeeded") {
            void reviewAfterSuccess(sessionID, event?.id)
          }
        }
      } catch {
        // 事件流断开只是不再清零计数，不影响拦截与切换。
      }
    })()
    void resetSubscription

    // 超时状态探针：只探带 superagent 配置且当前 root 启用协作的家族里的子会话。
    const probeScanner = createCtxProbeScanner(ctx)
    // 超长上下文自动压缩：同一个 5 分钟周期内逐 root 判断开关。
    const ctxScanner = createCtxContextCompactionScanner(ctx)
    const probeTimer = startProbeTimer(async () => {
      await Promise.allSettled([probeScanner.scan(), ctxScanner.scan()])
    })

    pruneClaims()

    log({
      event: "setup",
      decision: "allow",
      root: null,
      count: null,
      limit: null,
      toolError: ToolError ? "Tool.Error" : "plain Error",
    })

    return async () => {
      try {
        before?.dispose?.()
      } catch {}
      try {
        after?.dispose?.()
      } catch {}
      try {
        retry?.dispose?.()
      } catch {}
      try {
        resetAbort.abort()
      } catch {}
      try {
        probeTimer.stop()
      } catch {}
      try {
        watcher.stop()
      } catch {}
      try {
        quotaFallback.dispose()
      } catch {}
      try {
        await interruptRegistration?.dispose?.()
      } catch {}
      try {
        await skillRegistration?.dispose?.()
      } catch {}
      log({ event: "dispose", decision: "allow", root: null, count: null, limit: null })
    }
  },
}
