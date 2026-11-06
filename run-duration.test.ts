import { describe, expect, test } from "bun:test"
import { formatRunDuration, LONG_RUNNING_THRESHOLD_MS, sessionStatusView } from "./run-duration"

const NOW = 1_800_000_000_000
const MINUTE = 60_000

/** 运行中的会话：只有 busy 时间，还没有 idle。 */
function running(busy: number) {
  return { time: { busy } }
}

describe("formatRunDuration", () => {
  test("不足一小时按分钟取整", () => {
    expect(formatRunDuration(0)).toBe("0m")
    expect(formatRunDuration(59 * MINUTE)).toBe("59m")
    expect(formatRunDuration(59 * MINUTE + 59_999)).toBe("59m")
  })

  test("满一小时写成 1h23m", () => {
    expect(formatRunDuration(60 * MINUTE)).toBe("1h0m")
    expect(formatRunDuration(83 * MINUTE)).toBe("1h23m")
    expect(formatRunDuration(145 * MINUTE)).toBe("2h25m")
  })

  test("负数时间不产生异常文案", () => {
    expect(formatRunDuration(-MINUTE)).toBe("0m")
  })
})

describe("sessionStatusView 运行时长", () => {
  test("运行中文案带时长", () => {
    const view = sessionStatusView(running(NOW - 12 * MINUTE), true, { now: NOW, duration: true })
    expect(view).toEqual({ glyph: "●", text: "进行中 12m", longRunning: false })
  })

  test("root 行（duration 关闭）不显示时长", () => {
    const view = sessionStatusView(running(NOW - 42 * MINUTE), true, { now: NOW, duration: false })
    expect(view.text).toBe("进行中")
    expect(view.longRunning).toBe(false)
  })

  test("缺 busy 时间时不显示时长", () => {
    const view = sessionStatusView({ time: {} }, true, { now: NOW, duration: true })
    expect(view.text).toBe("进行中")
  })
})

describe("sessionStatusView 超时警示", () => {
  test("阈值边界：29 分钟不警示", () => {
    const view = sessionStatusView(running(NOW - 29 * MINUTE), true, { now: NOW, duration: true })
    expect(view.text).toBe("进行中 29m")
    expect(view.longRunning).toBe(false)
  })

  test("阈值边界：恰好 30 分钟开始警示", () => {
    const view = sessionStatusView(running(NOW - LONG_RUNNING_THRESHOLD_MS), true, { now: NOW, duration: true })
    expect(view.text).toBe("进行中 30m ⚠")
    expect(view.longRunning).toBe(true)
  })

  test("阈值边界：31 分钟警示", () => {
    const view = sessionStatusView(running(NOW - 31 * MINUTE), true, { now: NOW, duration: true })
    expect(view.text).toBe("进行中 31m ⚠")
    expect(view.longRunning).toBe(true)
  })

  test("超过一小时写成 1h23m 并警示", () => {
    const view = sessionStatusView(running(NOW - 83 * MINUTE), true, { now: NOW, duration: true })
    expect(view.text).toBe("进行中 1h23m ⚠")
  })
})

describe("sessionStatusView 活跃集合优先", () => {
  test("残留 interrupted 但在活跃集合中：显示进行中并带时长", () => {
    const view = sessionStatusView(
      { outcome: "interrupted", time: { busy: NOW - 5 * MINUTE, idle: NOW - 6 * MINUTE } },
      true,
      { now: NOW, duration: true },
    )
    expect(view).toEqual({ glyph: "●", text: "进行中 5m", longRunning: false })
  })

  test("残留 succeeded 但在活跃集合中：仍按进行中显示", () => {
    const view = sessionStatusView(
      { outcome: "succeeded", time: { busy: NOW - 2 * MINUTE } },
      true,
      { now: NOW, duration: true },
    )
    expect(view.text).toBe("进行中 2m")
  })
})

describe("sessionStatusView 结束态", () => {
  test("已完成不显示时长", () => {
    const view = sessionStatusView(
      { outcome: "succeeded", time: { busy: NOW - 90 * MINUTE, idle: NOW - MINUTE } },
      false,
      { now: NOW, duration: true },
    )
    expect(view).toEqual({ glyph: "✓", text: "已完成", longRunning: false })
  })

  test("失败不显示时长", () => {
    const view = sessionStatusView(
      { outcome: "failed", time: { busy: NOW - 90 * MINUTE, idle: NOW } },
      false,
      { now: NOW, duration: true },
    )
    expect(view).toEqual({ glyph: "✗", text: "失败", longRunning: false })
  })

  test("不在活跃集合且 outcome=interrupted：已中断，不带时长", () => {
    const view = sessionStatusView(
      { outcome: "interrupted", time: { busy: NOW - 5 * MINUTE, idle: NOW - 6 * MINUTE } },
      false,
      { now: NOW, duration: true },
    )
    expect(view).toEqual({ glyph: "Ⅱ", text: "已中断", longRunning: false })
  })

  test("失败且 busy 比 idle 新时仍按结束态显示", () => {
    const view = sessionStatusView(
      { outcome: "failed", time: { busy: NOW - 2 * MINUTE, idle: NOW - 3 * MINUTE } },
      false,
      { now: NOW, duration: true },
    )
    expect(view).toEqual({ glyph: "✗", text: "失败", longRunning: false })
  })
})

describe("sessionStatusView 时间戳兜底", () => {
  test("无活跃标记也无结果、busy 比 idle 新：按进行中显示（旧数据）", () => {
    const view = sessionStatusView(
      { time: { busy: NOW - 8 * MINUTE, idle: NOW - 9 * MINUTE } },
      false,
      { now: NOW, duration: true },
    )
    expect(view.text).toBe("进行中 8m")
  })

  test("无活跃标记也无结果、idle 比 busy 新：等待中", () => {
    const view = sessionStatusView(
      { time: { busy: NOW - 90 * MINUTE, idle: NOW - 80 * MINUTE } },
      false,
      { now: NOW, duration: true },
    )
    expect(view).toEqual({ glyph: "○", text: "等待中", longRunning: false })
  })
})