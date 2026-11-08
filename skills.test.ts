import { describe, expect, test } from "bun:test"

import { OVERSIGHT_ACCEPTANCE } from "./oversight"
import {
  SUPERAGENT_ACCEPTANCE_SKILL,
  SUPERAGENT_CONTEXT_SKILL,
  SUPERAGENT_ORCHESTRATION_SKILL,
  SUPERAGENT_SKILLS,
  superagentSkill,
} from "./skills"

describe("superagent skills", () => {
  test("exports the three registrable skills with complete fields", () => {
    expect(SUPERAGENT_SKILLS).toHaveLength(3)
    expect(new Set(SUPERAGENT_SKILLS.map((skill) => skill.id)).size).toBe(3)
    for (const skill of SUPERAGENT_SKILLS) {
      expect(skill.id).toMatch(/^superagent-[a-z]+$/)
      expect(skill.name.trim()).not.toBe("")
      expect(skill.description.trim()).not.toBe("")
      expect(skill.content.trim()).not.toBe("")
      expect(skill.path).toBe(`skill://${skill.id}/SKILL.md`)
    }
  })

  test("lookup and named exports resolve the same objects", () => {
    expect(superagentSkill("superagent-orchestration")).toBe(SUPERAGENT_ORCHESTRATION_SKILL)
    expect(superagentSkill("superagent-acceptance")).toBe(SUPERAGENT_ACCEPTANCE_SKILL)
    expect(superagentSkill("superagent-context")).toBe(SUPERAGENT_CONTEXT_SKILL)
    expect(superagentSkill("missing")).toBeUndefined()
  })

  test("orchestration covers delegation, the seven-field brief and upgrades", () => {
    const content = SUPERAGENT_ORCHESTRATION_SKILL.content
    expect(content).toContain("先判断是否适合 Flash")
    expect(content).toContain("新建还是续跑")
    expect(content).toContain("input.sessionID")
    for (const field of ["目标：", "范围：", "既定设计：", "关键指针：", "验收：", "歧义处理：", "交付格式："])
      expect(content).toContain(field)
    expect(content).toContain("耦合任务合并")
    expect(content).toContain("能力升级与限额切换分离")
    expect(content).toContain("旗舰子代理默认上限 2")
    expect(content).toContain("总子代理上限")
    expect(content).toContain("Flash 反复返工或验收失败后")
    expect(content).toContain("也可以由 Superagent 升级为旗舰子代理")
    expect(content).not.toContain("升级发生在派工前")
    expect(content).toContain("收回任务重新设计")
    expect(content).toContain("不要让 Superagent 直接写实现")
    expect(content).not.toContain("或自己完成")
    expect(content).toContain("不得通过换工具")
  })

  test("orchestration explains the authorized same-flagship model path", () => {
    const content = SUPERAGENT_ORCHESTRATION_SKILL.content
    expect(content).toContain("用户已明确授权")
    expect(content).toContain("providerID/modelID#variant")
    expect(content).toContain("不要擅自设 model")
    expect(content).toContain("不是禁止本授权场景")
    expect(content).toContain("本技能的用户授权边界为准")
  })

  test("acceptance matches the L0-L4 contract names and depths", () => {
    const content = SUPERAGENT_ACCEPTANCE_SKILL.content
    for (const level of [0, 1, 2, 3, 4] as const) expect(content).toContain(OVERSIGHT_ACCEPTANCE[level].name)
    expect(content).toContain("L0 结果验收（低风险）")
    expect(content).toContain("L1 摘要验收（常规）")
    expect(content).toContain("L2 证据验收（默认）")
    expect(content).toContain("L3 全量验收（严格）")
    expect(content).toContain("L4 审计验收（独立复核）")
    expect(content).toContain("真实截图")
    expect(content).toContain("复跑关键命令")
    expect(content).toContain("独立 critic 强制复核")
    expect(content).toContain("遵循 root 的 critic 开关")
    expect(content).toContain("不新增验收等级设置")
    expect(content).toContain("报告详细度与验收深度相关但不是一回事")
  })

  test("context covers ctx, the 300K reminder and the delete rule", () => {
    const content = SUPERAGENT_CONTEXT_SKILL.content
    expect(content).toContain("input + cache read + cache write")
    expect(content).toContain("300K")
    expect(content).toContain("严格超过才提醒")
    expect(content).toContain("不是自动拆分任务")
    expect(content).toContain("按模型阈值策略")
    expect(content).toContain("compact 还是续跑")
    expect(content).toContain("按内容价值")
    expect(content).toContain("窗口足够")
    expect(content).toContain("直接续跑，不必 compact")
    expect(content).toContain("需要释放窗口")
    expect(content).toContain("大量可重读")
    expect(content).toContain("优先 steer 续跑或 compact")
    expect(content).toContain("删除 Subagent")
    expect(content).toContain("删除前先与用户确认")
    expect(content).not.toContain("交接摘要")
    expect(content).not.toContain("删除重建")
  })

  test("skills do not contradict each other on settings, caps or splitting", () => {
    const all = SUPERAGENT_SKILLS.map((skill) => skill.content).join("\n")
    expect(all).toContain("不是自动拆分任务")
    expect(all).not.toContain("自动升级")
    expect(all).not.toContain("自动绕过")
    expect(all).not.toContain("新增验收设置")
    expect(all).not.toContain("跳过验收")

    expect(SUPERAGENT_ACCEPTANCE_SKILL.content).toContain("不新增设置项")
    expect(SUPERAGENT_ORCHESTRATION_SKILL.content).toContain("仍受 root 的总子代理上限约束")
    expect(SUPERAGENT_CONTEXT_SKILL.content).toContain("不改变验收等级")
  })
})