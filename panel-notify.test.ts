/**
 * 面板手动操作回传：文案语义（主语必须是「用户」）、投递参数与失败时的容错。
 */
import { describe, expect, test } from "bun:test"

import { MAX_MANUAL_OP_LENGTH, createManualNotifier, manualOpText, notifyManualOp, type ManualOpAction } from "./panel-notify"

const DETAIL = { childID: "ses_x", childTitle: "实现侧栏标记" }

function fakeContext(options: { missing?: boolean; throws?: boolean; delayMs?: number } = {}) {
  const calls: any[] = []
  const stats = { maxInFlight: 0 }
  let inFlight = 0
  const session: any = options.missing
    ? {}
    : {
        synthetic: async (input: any) => {
          calls.push(input)
          inFlight += 1
          stats.maxInFlight = Math.max(stats.maxInFlight, inFlight)
          try {
            if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
            if (options.throws) throw new Error("synthetic failed")
            return { id: "syn_1" }
          } finally {
            inFlight -= 1
          }
        },
      }
  return { context: { client: { session } }, calls, stats }
}

describe("manualOpText", () => {
  const cases: Array<[ManualOpAction, string[], string[]]> = [
    ["delete", ["用户", "手动删除了", "实现侧栏标记（ses_x）", "已不可恢复"], ["保护"]],
    ["compact", ["用户", "原生上下文压缩", "读数随后下降是预期行为"], ["手动删除"]],
    ["keep", ["用户", "开启了保护", "不会被自动淘汰"], ["解除"]],
    ["unkeep", ["用户", "解除了", "可以被自动淘汰"], ["开启了保护"]],
    ["collab", ["用户", "启用了本会话的协作模式总开关", "硬拦截"], ["停用了"]],
    ["max-subagents", ["用户", "子代理数量上限改为5", "超出后会自动淘汰"], ["旗舰子代理数量上限"]],
    ["max-flagship", ["用户", "旗舰子代理数量上限改为2", "切到子代理默认模型", "不删除会话", "后续步骤使用新模型"], ["超出后会自动淘汰最旧的已完成子代理", "预期中断"]],
    ["model", ["面板手动", "切换为K3.1 Pro", "官方直接切换", "后续步骤使用新模型", "不中断当前步骤"], ["预期中断", "预期行为"]],
    ["setting", ["用户", "「报告风格」", "详细", "这不是你的指令", "已保存并生效"], ["子代理"]],
  ]

  const valueFor = (action: ManualOpAction) =>
    action === "max-subagents"
      ? "5"
      : action === "max-flagship"
        ? "2"
        : action === "model"
          ? "K3.1 Pro"
          : action === "setting"
            ? "详细"
            : undefined

  for (const [action, expected, forbidden] of cases) {
    test(`${action} 的文案写清是用户做的`, () => {
      const detail = action === "setting" ? { ...DETAIL, label: "报告风格", value: valueFor(action) } : { ...DETAIL, value: valueFor(action) }
      const text = manualOpText(action, detail)
      expect(text.startsWith("[superagent] ")).toBe(true)
      expect(text).toContain("用户")
      expect(text).toContain("这不是你的指令")
      for (const item of expected) expect(text).toContain(item)
      for (const item of forbidden) expect(text).not.toContain(item)
    })
  }

  test("旗舰上限调小时写明本次切换与跳过数量", () => {
    const text = manualOpText("max-flagship", { value: "0", switched: 2, skipped: 1 })
    expect(text).toContain("上限改为0")
    expect(text).toContain("已切换 2 个")
    expect(text).toContain("跳过 1 个")
  })

  test("默认模型策略改动用策略文案，不声称模型已生效", () => {
    const auto = manualOpText("default-policy", { policy: "auto" })
    expect(auto).toContain("后续分配")
    expect(auto).toContain("没有被批量切换")

    const inherit = manualOpText("default-policy", { policy: "inherit" })
    expect(inherit).toContain("策略已保存")
    expect(inherit).toContain("不表示现有子代理都已切换成功")

    const fixed = manualOpText("default-policy", { policy: "fixed", value: "Flash" })
    expect(fixed).toContain("设为Flash")
    expect(fixed).toContain("策略已保存")
    expect(fixed).toContain("不表示全部已生效")
  })

  test("监管等级固定与恢复跟随默认都写清新等级", () => {
    const pinned = manualOpText("oversight", { ...DETAIL, value: "L3" })
    expect(pinned).toContain("用户")
    expect(pinned).toContain("L3")
    expect(pinned).toContain("验收")
    const followed = manualOpText("oversight", { ...DETAIL, value: "跟随默认 L2" })
    expect(followed).toContain("跟随默认 L2")
  })

  test("协作停用写明插件不再管编排", () => {
    const text = manualOpText("collab", { value: "停用" })
    expect(text).toContain("用户")
    expect(text).toContain("停用")
    expect(text).toContain("全部停止")
  })

  test("每子代理策略文案说清只影响该子代理，不冒充全局默认策略", () => {
    for (const policy of ["auto", "inherit", "fixed"] as const) {
      const text = manualOpText("child-policy", { ...DETAIL, policy })
      expect(text).toContain("实现侧栏标记（ses_x）")
      expect(text).toContain("只影响该子代理后续分配")
      expect(text).not.toContain("默认模型设为")
    }
  })

  test("没有标题时只写会话 ID", () => {
    expect(manualOpText("delete", { childID: "ses_x" })).toContain("（ses_x）")
  })

  test("超长文本截断到 1000 字", () => {
    const text = manualOpText("delete", { childID: "ses_x", childTitle: "x".repeat(3000) })
    expect(text.length).toBeLessThanOrEqual(MAX_MANUAL_OP_LENGTH)
  })
})

describe("notifyManualOp", () => {
  test("投递成功：synthetic 参数正确", async () => {
    const { context, calls } = fakeContext()
    const sent = await notifyManualOp(context, {
      rootID: "ses_root",
      childID: "ses_x",
      childTitle: "实现侧栏标记",
      action: "delete",
    })
    expect(sent).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].sessionID).toBe("ses_root")
    expect(calls[0].description).toBe("用户手动操作")
    expect(calls[0].text).toContain("用户")
    // 手动操作通知一律排队：成为待处理消息，不打断也不唤醒正在推理的会话。
    expect(calls[0].delivery).toBe("queue")
    // 不显式 resume：排队消息由宿主在下一回合带入。
    expect("resume" in calls[0]).toBe(false)
    expect(calls[0].metadata).toEqual({
      source: "superagent-agents",
      kind: "manual-op",
      action: "delete",
      childID: "ses_x",
    })
  })

  test("没有子代理时不写 childID", async () => {
    const { context, calls } = fakeContext()
    await notifyManualOp(context, { rootID: "ses_root", action: "collab", detail: { value: "启用" } })
    expect(calls[0].metadata.childID).toBeUndefined()
    expect(calls[0].metadata.kind).toBe("manual-op")
  })

  test("缺 root 会话：返回 false 且不投递", async () => {
    const { context, calls } = fakeContext()
    expect(await notifyManualOp(context, { action: "delete" })).toBe(false)
    expect(calls).toEqual([])
  })

  test("宿主没有 synthetic：返回 false 且不抛", async () => {
    const { context, calls } = fakeContext({ missing: true })
    expect(await notifyManualOp(context, { rootID: "ses_root", action: "delete" })).toBe(false)
    expect(calls).toEqual([])
  })

  test("投递抛错：返回 false 且不抛", async () => {
    const { context } = fakeContext({ throws: true })
    expect(await notifyManualOp(context, { rootID: "ses_root", action: "delete" })).toBe(false)
  })

  test("细节里带的子代理信息也会写进正文", async () => {
    const { context, calls } = fakeContext()
    await notifyManualOp(context, {
      rootID: "ses_root",
      action: "keep",
      detail: { childID: "ses_y", childTitle: "细节里的子代理" },
    })
    expect(String(calls[0].text)).toContain("细节里的子代理（ses_y）")
    expect(calls[0].metadata.childID).toBe("ses_y")
  })
})

describe("createManualNotifier", () => {
  test("delete 立即发送，不等聚合窗口", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 500,
    })
    expect(await notifier.notify({ action: "delete", childID: "ses_x" })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].metadata.action).toBe("delete")
    expect(calls[0].delivery).toBe("queue")
    notifier.dispose()
  })

  test("连续同类操作只发最后一条", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 20,
    })
    const first = notifier.notify({ action: "keep", childID: "ses_x", childTitle: "甲" })
    const second = notifier.notify({ action: "keep", childID: "ses_x", childTitle: "乙" })
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(calls).toHaveLength(1)
    expect(String(calls[0].text)).toContain("乙")
    expect(String(calls[0].text)).not.toContain("甲")
    // 所有手动操作通知都以 queue 投递。
    expect(calls.every((call: any) => call.delivery === "queue")).toBe(true)
    notifier.dispose()
  })

  test("keep 与 unkeep 共用一组：只留最后一条", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 20,
    })
    const first = notifier.notify({ action: "keep", childID: "ses_x" })
    const second = notifier.notify({ action: "unkeep", childID: "ses_x" })
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].metadata.action).toBe("unkeep")
    notifier.dispose()
  })

  test("不同操作在同一个窗口里聚合成一条 synthetic", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 20,
    })
    const first = notifier.notify({ action: "oversight", childID: "ses_x", detail: { value: "L3" } })
    const second = notifier.notify({ action: "oversight", childID: "ses_y", detail: { value: "L1" } })
    const third = notifier.notify({ action: "max-subagents", detail: { value: "5" } })
    expect(await Promise.all([first, second, third])).toEqual([true, true, true])
    expect(calls).toHaveLength(1)
    expect(String(calls[0].text)).toContain("L3")
    expect(String(calls[0].text)).toContain("L1")
    expect(String(calls[0].text)).toContain("子代理数量上限改为5")
    expect(calls[0].metadata.action).toBe("batch")
    expect(calls[0].metadata.actions).toEqual(["oversight", "oversight", "max-subagents"])
    expect(calls[0].delivery).toBe("queue")
    notifier.dispose()
  })

  test("同组重复只留最后，不同操作仍合并成同一条", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 20,
    })
    const first = notifier.notify({ action: "max-flagship", detail: { value: "2" } })
    const second = notifier.notify({ action: "max-flagship", detail: { value: "1" } })
    const third = notifier.notify({ action: "setting", detail: { label: "报告风格", value: "详细" } })
    expect(await Promise.all([first, second, third])).toEqual([true, true, true])
    expect(calls).toHaveLength(1)
    expect(String(calls[0].text)).toContain("上限改为1")
    expect(String(calls[0].text)).not.toContain("上限改为2")
    expect(String(calls[0].text)).toContain("报告风格")
    expect(calls[0].metadata.actions).toEqual(["max-flagship", "setting"])
    notifier.dispose()
  })

  test("两个立即操作串行投递：先点的先发，且不与窗口冲刷交错", async () => {
    const { context, calls, stats } = fakeContext({ delayMs: 30 })
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 500,
    })
    const pending = notifier.notify({ action: "keep", childID: "ses_x" })
    const first = notifier.notify({ action: "delete", childID: "ses_a" })
    const second = notifier.notify({ action: "delete", childID: "ses_b" })
    expect(await Promise.all([pending, first, second])).toEqual([true, true, true])
    expect(calls.map((call: any) => call.metadata.action)).toEqual(["keep", "delete", "delete"])
    expect(calls[1].metadata.childID).toBe("ses_a")
    expect(calls[2].metadata.childID).toBe("ses_b")
    // 任何时刻只有一条通知在投递：两个立即操作不会并发入队。
    expect(stats.maxInFlight).toBe(1)
    notifier.dispose()
  })

  test("立即操作先冲刷窗口里的 pending，再单独 queue 投递", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 500,
    })
    const pending = notifier.notify({ action: "keep", childID: "ses_x" })
    expect(await notifier.notify({ action: "delete", childID: "ses_y" })).toBe(true)
    expect(await pending).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0].metadata.action).toBe("keep")
    expect(calls[1].metadata.action).toBe("delete")
    expect(calls.every((call: any) => call.delivery === "queue")).toBe(true)
    notifier.dispose()
  })

  test("投递失败：返回 false，让上层提示", async () => {
    const { context } = fakeContext({ throws: true })
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 20,
    })
    expect(await notifier.notify({ action: "delete" })).toBe(false)
    expect(await notifier.notify({ action: "keep", childID: "ses_x" })).toBe(false)
    notifier.dispose()
  })

  test("没有 root 会话：跳过且不算失败", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => undefined,
      delayMs: 20,
    })
    expect(await notifier.notify({ action: "delete" })).toBe(true)
    expect(await notifier.notify({ action: "keep", childID: "ses_x" })).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(calls).toEqual([])
    notifier.dispose()
  })

  test("800ms 窗口内关闭面板：pending 仍聚合成一条完整批次补发", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 800,
    })
    const first = notifier.notify({ action: "setting", detail: { label: "报告风格", value: "详细" } })
    const second = notifier.notify({ action: "max-subagents", detail: { value: "5" } })
    // 窗口还没到就卸载面板。
    notifier.dispose()
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(calls).toHaveLength(1)
    expect(String(calls[0].text)).toContain("报告风格")
    expect(String(calls[0].text)).toContain("子代理数量上限改为5")
    expect(calls[0].metadata.action).toBe("batch")
    expect(calls[0].metadata.actions).toEqual(["setting", "max-subagents"])
    expect(calls[0].delivery).toBe("queue")
    // 已发出的批次不会因定时器或再次 dispose 重复投递。
    notifier.dispose()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(calls).toHaveLength(1)
  })

  test("dispose 之后的新调用不再投递", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 20,
    })
    notifier.dispose()
    expect(await notifier.notify({ action: "keep", childID: "ses_x" })).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(calls).toEqual([])
  })

  test("窗口内无 pending 时 dispose 不投递", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 20,
    })
    notifier.dispose()
    expect(calls).toEqual([])
  })

  test("聚合正文仍有长度上限", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      delayMs: 20,
    })
    const pending: Promise<boolean>[] = []
    for (let index = 0; index < 30; index += 1) {
      pending.push(
        notifier.notify({
          action: "setting",
          detail: { label: `设置项 ${index}`, value: "x".repeat(80) },
        }),
      )
    }
    expect((await Promise.all(pending)).every(Boolean)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(String(calls[0].text).length).toBeLessThanOrEqual(MAX_MANUAL_OP_LENGTH)
    notifier.dispose()
  })
})
