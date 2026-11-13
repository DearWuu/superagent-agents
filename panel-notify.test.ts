/**
 * 面板手动操作回传：文案语义（主语必须是「用户」）、投递参数与失败时的容错。
 */
import { describe, expect, test } from "bun:test"

import { MAX_MANUAL_OP_LENGTH, createManualNotifier, manualOpText, notifyManualOp, type ManualOpAction } from "./panel-notify"

const DETAIL = { childID: "ses_x", childTitle: "实现侧栏标记" }

function fakeContext(options: { missing?: boolean; throws?: boolean } = {}) {
  const calls: any[] = []
  const session: any = options.missing
    ? {}
    : {
        synthetic: async (input: any) => {
          calls.push(input)
          if (options.throws) throw new Error("synthetic failed")
          return { id: "syn_1" }
        },
      }
  return { context: { client: { session } }, calls }
}

describe("manualOpText", () => {
  const cases: Array<[ManualOpAction, string[], string[]]> = [
    ["delete", ["用户", "手动删除了", "实现侧栏标记（ses_x）", "已不可恢复"], ["保护"]],
    ["compact", ["用户", "原生上下文压缩", "读数随后下降是预期行为"], ["手动删除"]],
    ["keep", ["用户", "开启了保护", "不会被自动淘汰"], ["解除"]],
    ["unkeep", ["用户", "解除了", "可以被自动淘汰"], ["开启了保护"]],
    ["collab", ["用户", "启用了本会话的协作模式总开关", "硬拦截"], ["停用了"]],
    ["max-subagents", ["用户", "子代理数量上限改为5", "超出后会自动淘汰"], ["旗舰子代理数量上限"]],
    ["max-flagship", ["用户", "旗舰子代理数量上限改为2", "显式委派"], ["超出后会自动淘汰最旧的已完成子代理"]],
  ]

  for (const [action, expected, forbidden] of cases) {
    test(`${action} 的文案写清是用户做的`, () => {
      const text = manualOpText(action, { ...DETAIL, value: action === "max-subagents" ? "5" : action === "max-flagship" ? "2" : undefined })
      expect(text.startsWith("[superagent] ")).toBe(true)
      expect(text).toContain("用户")
      expect(text).toContain("这不是你的指令")
      for (const item of expected) expect(text).toContain(item)
      for (const item of forbidden) expect(text).not.toContain(item)
    })
  }

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
    // 手动操作不插当前轮：统一排队投递。
    expect(calls[0].delivery).toBe("queue")
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
  test("开关关闭：零投递，也不算失败", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      enabled: () => false,
      delayMs: 10,
    })
    expect(await notifier.notify({ action: "delete" })).toBe(true)
    expect(await notifier.notify({ action: "keep", childID: "ses_x" })).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(calls).toEqual([])
    notifier.dispose()
  })

  test("delete 立即发送，不等防抖窗口", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      enabled: () => true,
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
      enabled: () => true,
      delayMs: 20,
    })
    const first = notifier.notify({ action: "keep", childID: "ses_x", childTitle: "甲" })
    const second = notifier.notify({ action: "keep", childID: "ses_x", childTitle: "乙" })
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(calls).toHaveLength(1)
    expect(String(calls[0].text)).toContain("乙")
    // 所有手动操作通知都排队投递。
    expect(calls.every((call: any) => call.delivery === "queue")).toBe(true)
    notifier.dispose()
  })

  test("keep 与 unkeep 共用一组：只留最后一条", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      enabled: () => true,
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

  test("不同子代理的监管等级各发一条", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      enabled: () => true,
      delayMs: 20,
    })
    await notifier.notify({ action: "oversight", childID: "ses_x", detail: { value: "L3" } })
    await notifier.notify({ action: "oversight", childID: "ses_y", detail: { value: "L1" } })
    expect(calls).toHaveLength(2)
    expect(calls.map((call: any) => call.metadata.childID).sort()).toEqual(["ses_x", "ses_y"])
    notifier.dispose()
  })

  test("上限各用一组：两个上限都发", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      enabled: () => true,
      delayMs: 20,
    })
    await notifier.notify({ action: "max-subagents", detail: { value: "5" } })
    await notifier.notify({ action: "max-flagship", detail: { value: "2" } })
    expect(calls).toHaveLength(2)
    expect(calls.map((call: any) => call.metadata.action)).toEqual(["max-subagents", "max-flagship"])
    notifier.dispose()
  })

  test("投递失败：返回 false，让上层提示", async () => {
    const { context } = fakeContext({ throws: true })
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      enabled: () => true,
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
      enabled: () => true,
      delayMs: 20,
    })
    expect(await notifier.notify({ action: "delete" })).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(calls).toEqual([])
    notifier.dispose()
  })

  test("dispose 之后不再投递", async () => {
    const { context, calls } = fakeContext()
    const notifier = createManualNotifier(context, {
      rootID: () => "ses_root",
      enabled: () => true,
      delayMs: 20,
    })
    const pending = notifier.notify({ action: "keep", childID: "ses_x" })
    notifier.dispose()
    expect(await pending).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(calls).toEqual([])
  })
})
