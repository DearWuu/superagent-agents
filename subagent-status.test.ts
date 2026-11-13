/**
 * 状态回传纯逻辑：派发台账与上限、回执文案与挂载、后台任务识别、通知与提醒判重。
 */
import { describe, expect, test } from "bun:test"

import {
  DISPATCH_LEDGER_LIMIT,
  MAX_RECEIPT_LENGTH,
  RUNTIME_METADATA_KEY,
  RUNTIME_STATE_BACKGROUND,
  STATUS_WATCH_KEY,
  attachDispatchReceipt,
  collectBackgroundJobs,
  completionState,
  createDispatchLedger,
  finalAssistantText,
  formatBackgroundNotice,
  formatCompletionNotice,
  formatDispatchReceipt,
  formatWatchReminder,
  hasNotice,
  isRunningBackgroundShell,
  jobSignature,
  messageText,
  messageTime,
  noticeStates,
  statusWatchEnabled,
  type DispatchRecord,
} from "./subagent-status"

function record(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    callID: "call-1",
    parentID: "ses_root",
    description: "任务",
    agent: "worker",
    mode: "new",
    decision: "allowed",
    background: false,
    interrupt: "not-needed",
    evicted: [],
    warnings: [],
    startedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

describe("派发台账", () => {
  test("begin 登记、update 合并、warn 追加告警", () => {
    const ledger = createDispatchLedger()
    ledger.begin("c1", { parentID: "ses_root", description: "任务", agent: "worker", mode: "new" })
    ledger.update("c1", { childID: "ses_child", background: true })
    ledger.warn("c1", "查询失败，已放行：boom")
    const found = ledger.peek("c1")
    expect(found?.childID).toBe("ses_child")
    expect(found?.background).toBe(true)
    expect(found?.warnings).toEqual(["查询失败，已放行：boom"])
  })

  test("同一 callID 再次 begin 是合并，不重置已有字段", () => {
    const ledger = createDispatchLedger()
    ledger.begin("c1", { parentID: "ses_root", description: "任务", agent: "worker" })
    ledger.update("c1", { childID: "ses_child", interrupt: "interrupted" })
    ledger.begin("c1", { parentID: "ses_root", description: "任务", agent: "worker" })
    const found = ledger.peek("c1")
    expect(found?.childID).toBe("ses_child")
    expect(found?.interrupt).toBe("interrupted")
  })

  test("update 与 warn 对未登记的 callID 不创建记录", () => {
    const ledger = createDispatchLedger()
    expect(ledger.update("nope", { childID: "x" })).toBeUndefined()
    expect(ledger.warn("nope", "boom")).toBeUndefined()
    expect(ledger.size()).toBe(0)
  })

  test("take 取出并移除", () => {
    const ledger = createDispatchLedger()
    ledger.begin("c1", { parentID: "ses_root" })
    expect(ledger.take("c1")?.callID).toBe("c1")
    expect(ledger.peek("c1")).toBeUndefined()
  })

  test("超过上限淘汰最旧的一条", () => {
    const ledger = createDispatchLedger(2)
    ledger.begin("c1", { parentID: "ses_root", startedAt: 10 })
    ledger.begin("c2", { parentID: "ses_root", startedAt: 20 })
    ledger.begin("c3", { parentID: "ses_root", startedAt: 30 })
    expect(ledger.size()).toBe(2)
    expect(ledger.peek("c1")).toBeUndefined()
    expect(ledger.peek("c2")?.callID).toBe("c2")
    expect(ledger.peek("c3")?.callID).toBe("c3")
  })

  test("默认上限是 200", () => {
    expect(DISPATCH_LEDGER_LIMIT).toBe(200)
    const ledger = createDispatchLedger()
    for (let index = 0; index < 210; index += 1) {
      ledger.begin(`c${index}`, { parentID: "ses_root", startedAt: index })
    }
    expect(ledger.size()).toBe(200)
    expect(ledger.peek("c0")).toBeUndefined()
  })

  test("prune 清掉过期登记", () => {
    const ledger = createDispatchLedger()
    ledger.begin("c1", { parentID: "ses_root" })
    ledger.prune(Date.now() + 10 * 60 * 60 * 1000, 60 * 60 * 1000)
    expect(ledger.size()).toBe(0)
  })

  test("多实例互不影响：没有模块级共享状态", () => {
    const first = createDispatchLedger()
    const second = createDispatchLedger()
    first.begin("c1", { parentID: "ses_root" })
    expect(second.size()).toBe(0)
    expect(second.peek("c1")).toBeUndefined()
  })
})

describe("派发回执", () => {
  test("字段齐全：模式、子会话、状态、模型、中断、淘汰", () => {
    const text = formatDispatchReceipt(
      record({ childID: "ses_x", model: "p/m", evicted: ["ses_y"], background: true, state: "running" }),
      { ok: true, state: "running" },
    )
    expect(text).toContain("dispatch=ok")
    expect(text).toContain("mode=new")
    expect(text).toContain("child=ses_x")
    expect(text).toContain("state=running")
    expect(text).toContain("model=p/m")
    expect(text).toContain("interrupt=not-needed")
    expect(text).toContain("evicted=ses_y")
    expect(text).toContain("完成后自动通知")
    expect(text.split("\n")).toHaveLength(1)
  })

  test("前台已完成的回执不承诺后续通知", () => {
    const text = formatDispatchReceipt(record({ childID: "ses_x", state: "completed" }), {
      ok: true,
      state: "completed",
    })
    expect(text).toContain("state=completed")
    expect(text).not.toContain("完成后自动通知")
  })

  test("告警追加 warning 段", () => {
    const text = formatDispatchReceipt(record({ warnings: ["查询失败，已放行：boom"] }))
    expect(text).toContain("warning=查询失败，已放行：boom")
  })

  test("拒绝时 dispatch=failed 且不承诺通知", () => {
    const text = formatDispatchReceipt(record({ decision: "denied", reason: "total-limit" }))
    expect(text).toContain("dispatch=failed")
    expect(text).not.toContain("完成后自动通知")
  })

  test("长度不超过 500 字", () => {
    const text = formatDispatchReceipt(record({ warnings: ["x".repeat(800)] }))
    expect(text.length).toBeLessThanOrEqual(MAX_RECEIPT_LENGTH)
  })
})

describe("回执挂到工具结果", () => {
  test("content 是字符串时追加在后面", () => {
    const result = attachDispatchReceipt({ content: "done" }, "[superagent] dispatch=ok")
    expect(result.content).toBe("done\n[superagent] dispatch=ok")
  })

  test("content 是数组时追加一个文本块", () => {
    const result = attachDispatchReceipt({ content: [{ type: "text", text: "done" }] }, "receipt")
    expect(result.content).toHaveLength(2)
    expect(result.content[1]).toEqual({ type: "text", text: "receipt" })
  })

  test("只有 output 时追加到 output", () => {
    const result = attachDispatchReceipt({ output: "done" }, "receipt")
    expect(result.output).toBe("done\nreceipt")
  })

  test("都没有时写 metadata.superagent", () => {
    const result = attachDispatchReceipt({ metadata: { keep: 1 } }, "receipt")
    expect(result.metadata).toEqual({ keep: 1, superagent: "receipt" })
  })

  test("非对象结果原样返回，不抛错", () => {
    expect(attachDispatchReceipt(undefined, "receipt")).toBeUndefined()
    expect(attachDispatchReceipt("text", "receipt")).toBe("text")
  })
})

describe("后台任务识别", () => {
  const shellMessage = {
    id: "msg_1",
    type: "shell",
    shellID: "sh_1",
    command: "npm run dev",
    status: "running",
    metadata: { background: true },
  }

  test("后台且仍在跑的 shell 是后台任务", () => {
    expect(isRunningBackgroundShell(shellMessage)).toEqual({
      kind: "shell",
      id: "sh_1",
      command: "npm run dev",
    })
  })

  test("前台 shell、已结束的 shell、非 shell 消息都不算", () => {
    expect(isRunningBackgroundShell({ ...shellMessage, metadata: {} })).toBeUndefined()
    expect(isRunningBackgroundShell({ ...shellMessage, status: "exited" })).toBeUndefined()
    expect(isRunningBackgroundShell({ type: "assistant" })).toBeUndefined()
  })

  test("子代理工具结果里 running 的子会话也算后台任务", () => {
    const messages = [
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "subagent",
            state: {
              status: "running",
              input: { description: "编排器" },
              metadata: { status: "running", sessionID: "ses_sub" },
            },
          },
        ],
      },
    ]
    expect(collectBackgroundJobs(messages)).toEqual([
      { kind: "subagent", id: "ses_sub", command: "编排器" },
    ])
  })

  test("collectBackgroundJobs 同时认出 shell 与子代理任务", () => {
    const messages = [shellMessage]
    const jobs = collectBackgroundJobs(messages)
    expect(jobs).toHaveLength(1)
    expect(jobSignature(jobs)).toBe("shell:sh_1")
  })

  test("没有后台任务时返回空数组", () => {
    expect(collectBackgroundJobs([])).toEqual([])
    expect(collectBackgroundJobs(undefined)).toEqual([])
  })
})

describe("通知与提醒文案", () => {
  test("后台通知写清任务清单", () => {
    const text = formatBackgroundNotice({
      childID: "ses_x",
      description: "任务",
      jobs: [
        { kind: "shell", id: "sh_1", command: "npm run dev" },
        { kind: "subagent", id: "ses_sub", command: "编排器" },
      ],
    })
    expect(text).toContain('<subagent sessionID="ses_x" state="idle-background" description="任务">')
    expect(text).toContain("仍有 2 个后台任务在运行")
    expect(text).toContain("- shell: npm run dev")
    expect(text).toContain("- subagent: 编排器")
    expect(text.endsWith("</subagent>")).toBe(true)
  })

  test("完成通知带最终输出", () => {
    const text = formatCompletionNotice({ childID: "ses_x", state: "completed", text: "干完了" })
    expect(text).toBe('<subagent sessionID="ses_x" state="completed">\n干完了\n</subagent>')
  })

  test("完成通知正文截断到 4000 字", () => {
    const text = formatCompletionNotice({ childID: "ses_x", state: "error", text: "y".repeat(5000) })
    expect(text).toContain("y".repeat(4000))
    expect(text).not.toContain("y".repeat(4001))
  })

  test("提醒文案写清子会话与状态", () => {
    expect(formatWatchReminder({ childID: "ses_x", state: "error" })).toBe(
      "[superagent] 监测到子代理 ses_x 已停止（error），此前没有收到完成确认；如已知晓可忽略。",
    )
  })
})

describe("通知判重", () => {
  const native = {
    type: "synthetic",
    payload: {
      text: '<subagent sessionID="ses_x" state="completed">done</subagent>',
      metadata: { source: "subagent", childID: "ses_x", state: "completed" },
    },
  }

  test("原生通知命中 metadata 来源", () => {
    expect(
      hasNotice([native], { childID: "ses_x", state: ["completed"], sources: ["subagent", "superagent-agents"] }),
    ).toBe(true)
  })

  test("状态不匹配时不算命中", () => {
    expect(
      hasNotice([native], { childID: "ses_x", state: ["error"], sources: ["subagent", "superagent-agents"] }),
    ).toBe(false)
  })

  test("没有 metadata 时按正文里的 subagent 标签判重", () => {
    const message = { type: "assistant", content: [{ type: "text", text: '<subagent sessionID="ses_x" state="completed">done</subagent>' }] }
    expect(hasNotice([message], { childID: "ses_x", sources: ["subagent"] })).toBe(true)
    expect(hasNotice([message], { childID: "ses_other", sources: ["subagent"] })).toBe(false)
  })

  test("别的子会话的通知不算命中", () => {
    expect(hasNotice([native], { childID: "ses_y", sources: ["subagent"] })).toBe(false)
  })

  test("插件自己的后台通知不会被当成完成通知", () => {
    const background = {
      type: "synthetic",
      metadata: { source: "superagent-agents", childID: "ses_x", state: "idle-background" },
      text: '<subagent sessionID="ses_x" state="idle-background">still running</subagent>',
    }
    expect(
      hasNotice([background], {
        childID: "ses_x",
        state: ["completed", "succeeded"],
        sources: ["subagent", "superagent-agents"],
      }),
    ).toBe(false)
  })
})

describe("消息文本与结束态", () => {
  test("最后一条 assistant 文本只取文本片段", () => {
    const messages = [
      { type: "assistant", content: [{ type: "text", text: "第一段" }] },
      {
        type: "assistant",
        content: [
          { type: "reasoning", text: "想了一想" },
          { type: "text", text: "最终结论" },
        ],
      },
    ]
    expect(finalAssistantText(messages)).toBe("最终结论")
  })

  test("没有 assistant 消息时返回空串", () => {
    expect(finalAssistantText([{ type: "user", content: [{ type: "text", text: "hi" }] }])).toBe("")
  })

  test("消息文本能取出工具结果里的正文", () => {
    const message = {
      type: "assistant",
      content: [
        {
          type: "tool",
          state: { status: "completed", content: [{ type: "text", text: '<subagent sessionID="ses_x" state="completed">ok</subagent>' }] },
        },
      ],
    }
    expect(messageText(message)).toContain("<subagent sessionID=\"ses_x\"")
  })

  test("消息时间兼容毫秒与 ISO 字符串", () => {
    expect(messageTime({ time: { created: 1234 } })).toBe(1234)
    expect(messageTime({ time: { created: "2026-01-01T00:00:00Z" } })).toBe(Date.parse("2026-01-01T00:00:00Z"))
    expect(messageTime({})).toBe(0)
  })

  test("结束态映射与别名", () => {
    expect(completionState("succeeded")).toBe("completed")
    expect(completionState("failed")).toBe("error")
    expect(completionState("interrupted")).toBe("cancelled")
    expect(completionState("unknown")).toBeUndefined()
    expect(noticeStates("error")).toEqual(["error", "failed"])
    expect(noticeStates("completed")).toEqual(["completed", "succeeded"])
  })
})

describe("状态监测开关", () => {
  test("缺省按启用处理", () => {
    expect(statusWatchEnabled([])).toBe(true)
  })

  test("明确的 false 才停用", () => {
    expect(statusWatchEnabled([{ key: STATUS_WATCH_KEY, value: "false" }])).toBe(false)
    expect(statusWatchEnabled([{ key: STATUS_WATCH_KEY, value: "FALSE" }])).toBe(false)
    expect(statusWatchEnabled([{ key: STATUS_WATCH_KEY, value: "true" }])).toBe(true)
  })

  test("非法值按启用处理", () => {
    expect(statusWatchEnabled([{ key: STATUS_WATCH_KEY, value: "maybe" }])).toBe(true)
    expect(statusWatchEnabled([{ key: STATUS_WATCH_KEY, value: 7 }])).toBe(true)
  })
})

describe("运行状态标记", () => {
  test("键名与取值固定", () => {
    expect(RUNTIME_METADATA_KEY).toBe("superagent.runtime")
    expect(RUNTIME_STATE_BACKGROUND).toBe("idle-background")
  })
})
