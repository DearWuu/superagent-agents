/**
 * Built-in skills for the Superagent / Subagent workflow.
 *
 * The Server entry registers these with `ctx.skill.transform` (one `editor.add`
 * per entry); this module stays pure data so the content and ids are testable
 * without the plugin host.
 */

export type SuperagentSkill = {
  id: string
  name: string
  description: string
  /** Virtual skill path, always `skill://<id>/SKILL.md`. */
  path: string
  content: string
}

const ORCHESTRATION_CONTENT = `# Superagent 编排

Superagent 是旗舰模型，负责拆解、委派、验收与最终裁决；Subagent 是可替换的执行单元。

## 1. 先判断是否适合 Flash
- 适合 Flash：边界清晰、步骤机械、能写成短任务契约、失败成本低、结果可快速验证。
- 不适合 Flash：目标含糊、跨模块设计、需要取舍、强耦合、高风险不可逆操作、需要反复试探。
- 不确定时先让 Flash 做一次可验证的侦察或取样；结论不足再升级，不要一开始就把所有任务交给旗舰子代理。

## 2. 再决定新建还是续跑
- 新任务、与现有子会话上下文无关：新建 Subagent。
- 同一任务的后续修正、补充验证、继续同一上下文：用 input.sessionID 续跑，不重复新建。
- 同一目标不要并行开多个子代理做重复工作；确需并行时，任务契约必须互不重叠。

## 3. 七字段短任务契约
每次派工必须写全，缺一项就算任务书不合格：
1. 目标：一句话说明要达成的结果，不写过程。
2. 范围：允许改动的文件或目录，以及禁止触碰的范围。
3. 既定设计：已经定下的方案、接口、命名与约束，执行者不再自行选型。
4. 关键指针：需要读的文件 path:行号、日志、参考实现或外部文档。
5. 验收：可观察的通过条件与必须运行的命令。
6. 歧义处理：遇到未覆盖的问题时，是停下提问还是按最小改动继续。
7. 交付格式：报告章节、证据形式与指针要求，与该子代理的监管等级一致。

## 4. 耦合任务合并
- 多个子任务共享同一批文件、同一套上下文或存在先后依赖时，合并成一个任务交给一个子代理。
- 拆分只在任务可独立验收、上下文可独立携带时进行。
- 合并后仍用七字段契约表达，不因任务变大而省略验收。

## 5. 能力升级与限额切换分离
- 能力升级：派工前可判断任务对推理或设计能力的要求超出 Flash，主动改用旗舰子代理；Flash 反复返工或验收失败后，也可以由 Superagent 升级为旗舰子代理继续。
- 限额切换：遇到限流或余额不足时按已配置的备用模型切换；这是可用性降级，不是能力升级。
- 两者不得混用：不要用限额切换掩盖任务难度，也不要把能力升级当成重试手段。

## 6. 同款旗舰子代理（用户已授权）
- 用户已明确授权：需要升级，或主动需要一个与 Superagent 同模型的子代理时，Superagent 可以用原生 subagent 工具创建与自身相同的旗舰模型子代理。
- model 取当前系统信息里的 providerID/modelID#variant，原样填写；不要猜、不要改写、不要挑其他模型。
- 旗舰子代理默认上限 2 个，并且仍受 root 的总子代理上限约束；只有像本节这样显式填写同款 model 的委派才占旗舰名额，继承或默认模型带来的同模型不算。
- 达到旗舰上限或总上限时，等待、合并任务、续跑现有子会话，或收回任务重新设计；不要让 Superagent 直接写实现；不得通过换工具、换参数、伪造 model 等方式绕过上限。

## 7. 与工具描述的冲突
- 原生 subagent 工具描述写“不要擅自设 model”，意思是禁止模型猜测与未经授权的路由，不是禁止本授权场景。
- 本场景的 model 来自当前系统信息的同款旗舰模型，属于用户预先授权的确定性取值；除此之外仍不得擅自指定其他 model。
- 工具描述与本技能冲突时，以本技能的用户授权边界为准：只允许同款旗舰模型，且只在升级或主动需要同模型时使用。
`

const ACCEPTANCE_CONTENT = `# Superagent 验收

验收深度跟随每个子代理的实际监管等级（含会话、模型与全局 pin），不新增验收等级设置。报告详细度与验收深度相关但不是一回事：报告可以写得更细，验收仍按该子代理的等级执行。

## L0 结果验收（低风险）
- 结论：接受子代理的完成结论，不要求过程记录。
- 改动范围：确认与任务书一致，没有未声明的高风险改动。
- 测试结论：核对报告里的测试结论；低风险改动不要求复跑。

## L1 摘要验收（常规）
- 命令清单：核对执行过的命令与 exit code。
- 阶段小结：逐段确认阶段结果与目标一致。
- 抽查：对关键改动做抽样核对，不逐行复读。

## L2 证据验收（默认）
- 真实输出指针：核对 path:行号 或日志文件，不接受口头复述。
- 关键 diff：查看改动本身，确认与目标一致。
- 失败证据：失败命令必须有失败输出与原因，不接受只写结论。
- 界面改动：必须提供真实截图，不接受文字描述代替。

## L3 全量验收（严格）
- 复跑关键命令：以实际输出为准。
- 关键代码：逐处阅读改动与修改理由。
- 边界回归：按任务书的验收点做边界与回归检查。
- critic：遵循 root 的 critic 开关，不强制。

## L4 审计验收（独立复核）
- 独立 critic 强制复核：不依赖 critic 开关。
- Superagent 裁决：结合 critic 结论与证据做最终裁决。
- 重复运行：关键检查与不稳定检查重复执行，确认结果可复现。
- 完整审计：命令、代码、假设与备选方案逐项核对；结论冲突时按证据重新裁定。

## 边界
- pin 改变的是该子代理的监管等级，验收动作随等级切换，不新增设置项。
- 任何等级都要求证据真实；等级只决定验收做到多深。
`

const CONTEXT_CONTENT = `# Superagent 上下文

## ctx 口径
- ctx 用量取该会话最近一次 assistant 调用的输入侧 tokens：input + cache read + cache write。
- 跳过 compact 之前的旧记录，只看 compact 之后当前这一步的长度。
- 与面板展示保持同一口径，不用累计输出 tokens 估算。

## 300K 默认阈值
- 默认阈值是 300K tokens，严格超过才触发自动压缩。
- 超过阈值由插件直接对该子代理发起原生 compact，与手动点「压缩上下文」是同一操作；不是自动拆分任务，也不向 root/child 发提示词。
- 不自动拆分的原因：自动拆分会复制上下文、制造跨会话依赖并丢失连续性；是否拆分按内容价值与任务边界判断。

## 按模型阈值策略
- 阈值随模型上下文窗口配置：窗口更大的模型更晚触发，窗口更小的模型更早触发。
- 阈值只决定触发时机，不改变验收等级。
- 自动 compact 是原生会话操作，保持当前模型；失败只记日志，不重试轰炸。

## compact 还是续跑
- 内容仍有高价值、后续步骤依赖当前推理与决策，且窗口足够：直接续跑，不必 compact。
- 需要释放窗口时：compact 后继续。
- 上下文里存在大量可重读的文件与命令输出：先精简或 compact，再按需重读。
- 需要继续同一任务时优先 steer 续跑或 compact，保留上下文。
- 不为省 token 丢失关键约束，也不为保留全文硬撑到 compact。

## 删除 Subagent
- 删除只移除子会话及其上下文，不重建、不导出上下文。
- 只有不再需要该上下文时才删除，删除前先与用户确认。
- 受保护的子代理同样可以手动删除；保护只挡自动淘汰与模型批量修改。
`

const skill = (id: string, name: string, description: string, content: string): SuperagentSkill => ({
  id,
  name,
  description,
  path: `skill://${id}/SKILL.md`,
  content,
})

export const SUPERAGENT_ORCHESTRATION_SKILL = skill(
  "superagent-orchestration",
  "Superagent 编排",
  "在 Superagent 收到任务、准备委派给子代理时使用：判断是否适合 Flash、新建还是续跑、如何写七字段短任务契约、耦合任务是否合并、何时升级到同款旗舰模型，以及上限与限额切换的边界。",
  ORCHESTRATION_CONTENT,
)

export const SUPERAGENT_ACCEPTANCE_SKILL = skill(
  "superagent-acceptance",
  "Superagent 验收",
  "在 Superagent 验收子代理结果时使用：按该子代理实际监管等级 L0-L4 选择验收深度，核对证据、截图、复跑与 critic 复核。",
  ACCEPTANCE_CONTENT,
)

export const SUPERAGENT_CONTEXT_SKILL = skill(
  "superagent-context",
  "Superagent 上下文",
  "在 Superagent 或子代理管理上下文时使用：理解 ctx 口径与 300K 阈值、按模型阈值策略处理、按内容价值选择 compact 或续跑、以及何时删除 Subagent。",
  CONTEXT_CONTENT,
)

export const SUPERAGENT_SKILLS: readonly SuperagentSkill[] = [
  SUPERAGENT_ORCHESTRATION_SKILL,
  SUPERAGENT_ACCEPTANCE_SKILL,
  SUPERAGENT_CONTEXT_SKILL,
]

export function superagentSkill(id: string): SuperagentSkill | undefined {
  return SUPERAGENT_SKILLS.find((item) => item.id === id)
}