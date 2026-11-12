# superagent-agents

OpenCode 的 Superagent / Subagent 编排插件：把「主代理只做设计和验收、子代理并行实现」这套协作方式做成可操作的右栏面板，并在服务端兜住子代理数量、失败切换与超时卡死。

- TUI 入口（`./tui` → `index.tsx`）：右栏「agents协作」面板，展示子代理树、状态、模型、上下文读数与监管等级，点标题打开设置、点行看子代理操作。
- Server 入口（`./server` → `server.ts`）：子代理数量上限、旗舰子代理准入、限额自动切换备用模型、critic 复核、超时状态探针、超长上下文自动压缩，全部判定写入 `hook.log`；同时注册三个原生 Skills。

两个入口共用一份存储，装好即用，不需要额外配置。

## 安装

### 方式一：git clone 到插件目录（推荐，已实测）

```sh
git clone https://github.com/DearWuu/superagent-agents ~/.config/opencode/plugins/superagent-agents
```

重启 OpenCode 即生效。需要固定版本时 clone 对应 tag：

```sh
git clone --branch v0.2.2 --depth 1 https://github.com/DearWuu/superagent-agents ~/.config/opencode/plugins/superagent-agents
```

升级时进入该目录 `git pull`，再重启 OpenCode。

### 方式二：GitHub 插件 spec（备选）

```sh
opencode plugin add github:DearWuu/superagent-agents
```

或在 `opencode.jsonc` 里直接写：

```jsonc
{
  "plugins": ["github:DearWuu/superagent-agents"]
}
```

OpenCode 启动时由 Bun 从 GitHub 拉取仓库、装进自己的缓存（`~/.cache/opencode/`），随后 `opencode reload` 或重启即生效。升级用 `opencode plugin update`。固定版本时在 spec 后加 ref：

```sh
opencode plugin add github:DearWuu/superagent-agents#v0.2.2
```

```jsonc
{ "plugins": ["github:DearWuu/superagent-agents#v0.2.2"] }
```

当前 opencode 2.2.5 上 `plugin add` / GitHub spec 可能报 `git dep preparation failed`（内嵌安装器的已知问题）。遇到时改用方式一，已实测可用。

### 方式三：手动放目录（离线可用）

把整个目录放到插件目录，由 OpenCode 启动时自动发现：

```text
~/.config/opencode/plugins/superagent-agents/     # 全局
<项目>/.opencode/plugins/superagent-agents/       # 项目级
```

或在 `opencode.jsonc` 里写绝对路径（等价，适合放在别处时引用）：

```jsonc
{
  "plugins": ["/absolute/path/to/superagent-agents"]
}
```

Windows 下全局目录是 `%USERPROFILE%\.config\opencode\plugins\superagent-agents\`。

### 方式四：npm 包（尚未发布到 npm）

GitHub 是当前的分发方式，npm 包还没发布；下面写法等包上线后才可用。

```jsonc
{
  "plugins": ["superagent-agents@0.2.2"]
}
```

以包名引用时，OpenCode 用 Bun 在启动时把包装进自己的缓存（`~/.cache/opencode/` 下），因此该包必须能从本机 bun 的 registry 取到；离线或内网环境请用方式三。

### 不要用 `file:` 协议

```jsonc
{ "plugins": ["file:/absolute/path/to/superagent-agents"] }  // ✗ 不要这样写
```

`file:` 形式能让 server 钩子生效，但 TUI 面板会静默不加载（已实测：右栏什么也不显示，也没有报错）。要用路径就直接写路径字符串，不要加 `file:` 前缀。

### 依赖

`@opencode/plugin`、`@opentui/solid`、`solid-js` 三个 peer 依赖都声明为 optional，由宿主运行时提供，使用者不需要另装；已实测删掉 `node_modules` 后插件照常加载。

## 加载成功判据

同时满足三条才算装好：

1. **右栏出现「agents协作」**：TUI 右侧栏有子代理树面板。
2. **服务端日志有入口行**：`~/.local/share/opencode/log/opencode.log` 里出现

   ```text
   msg="loading plugin" id=.../superagent-agents entrypoint=file://.../superagent-agents/server.ts
   ```

   有面板、没有这一行 = 只有 TUI，没有服务端钩子（限额、切换、复核、探针、Skills 注册都不生效）。
3. **判定日志有 setup**：`~/.local/state/opencode/superagent/hook.log` 出现

   ```json
   {"plugin":"superagent-agents-hardlimit","event":"setup","decision":"allow"}
   ```

   该文件可用环境变量 `SUPERAGENT_HOOK_LOG` 改到别处；排查「限额不生效」「为什么不切换模型」都先看这里。

## 概念

**Superagent**（主代理）负责分析需求、拆解任务、方案设计、写任务书与验收标准、派工和验收，不自己写实现代码；**Subagent** 只按任务书实现并回报。面板就是这两者的调度台。常规组合是旗舰 Superagent + Flash Subagent：推理、拆解与裁决留在旗舰，边界清晰、可机械执行、失败成本低的工作交给 Flash。

**先判断再派工**：派工前先判断任务是否适合 Flash，再决定新建并行、合并还是续跑。适合 Flash 的是边界清晰、步骤机械、能写成短任务契约、结果可快速验证的工作；目标含糊、跨模块设计、需要取舍、强耦合或高风险不可逆操作不适合。无关联的独立任务默认新建 Subagent 并尽量并行；能独立验收、上下文可独立携带的任务尽量拆分。同文件或强耦合、并行会冲突的任务合并给一个子代理。续跑只用于同一模块的后续修改、验收打回后的返工与类似任务的迭代，用 `input.sessionID` steer；同一目标禁止重复派工，并行仍受子代理总上限与旗舰上限约束，不得绕过。

**续跑中断语义**：续跑运行中的子代理时，`interrupt` 默认 `true`，会先中断当前运行再发送新任务；显式传 `interrupt: false` 会保留当前运行并直接 steer。

**七字段任务契约**：目标、范围、既定设计、关键指针、验收、歧义处理、交付格式，七项写全才算合格任务书。

**能力升级与限额切换是两件事**：能力升级是判断任务超出 Flash 后主动改用旗舰子代理，或在 Flash 反复返工、验收失败后升级；限额切换是限流或余额不足时按备用模型做可用性降级，不是能力升级，也不能拿来掩盖任务难度。

**同款旗舰子代理**：用户已授权 Superagent 用原生 `subagent` 工具创建与自己相同 provider/model/variant 的旗舰子代理，model 取自当前系统信息并原样填写，不猜不改。旗舰配额只约束这种显式指定同款模型的委派：未显式指定 `model` 的继承、agent 默认模型、inherit/固定默认模型批量同步、UI 或限额切换（F2）改到的同模型，都是普通子代理，不占旗舰名额、不会被旗舰上限删除。旗舰默认上限 2（可设 0–20），且始终受子代理总上限约束；超限时先淘汰最旧已完成旗舰，运行中、正在 steer、受保护的旗舰不删，无可淘汰则明确拒绝。旗舰身份只认显式委派成功后写入会话元数据的 `superagent.flagship` 标记（带 `source: "explicit-subagent-delegation"` 来源）：其他来源或无来源的历史标记一律按普通子代理处理；root 之后切换模型不清洗标记，但子代理当前模型与标记模型不一致时标记过期、不再计入旗舰。任何显式 `input.model` 委派（含非旗舰模型）另写 `superagent.model-delegation` 标记；它不是旗舰身份，只用于让默认模型同步识别该子代理的模型由调用方显式指定。

**监管等级 L0–L4** 同时决定子代理报告要写到多细、验收要做到多深，不限制它能做什么：

| 等级 | 名称 | 必填章节（逐级累加） | 验收深度 | 交付节奏 |
| --- | --- | --- | --- | --- |
| L0 | 结果级 | 改动、测试、风险 | 结果验收（低风险）：接受结论、确认改动范围，低风险不要求复跑 | 完成/失败时一次 |
| L1 | 摘要级 | + 执行命令与 exit code、阶段小结 | 摘要验收（常规）：核对命令与 exit code、读阶段小结，关键改动抽查 | 完成/失败时一次 |
| L2 | 证据级（默认） | + 测试明细、读过的文件 path:行号、失败详情 | 证据验收（默认）：核对真实输出指针与关键 diff，失败必须有输出，界面改动用真实截图 | 完成/失败时一次 |
| L3 | 全量级 | + 命令完整输出、关键代码摘录、每文件改动理由 | 全量验收（严格）：复跑关键命令、逐处读代码、做边界回归；critic 跟随开关 | 结束总报告 + 中途简报 |
| L4 | 审计级 | + 每步动机、假设清单、考虑过又放弃的方案 | 审计验收（强制）：独立 critic 强制复核，重复运行关键检查，逐项审计后由 Superagent 裁决 | 每步汇报 + 结束总报告 |

等级按会话固定，可对整个 root 设默认、也可只固定某个子代理（子代理未固定时跟随默认）。pin 同时决定验收深度，没有额外的验收设置；报告可以写得更细，验收仍按该子代理的等级执行。L4 的独立 critic 不依赖 critic 开关；L0–L3 的 critic 复核跟随开关。协作模式总开关仍然优先：root 停用后，插件的 critic、探针与上下文自动压缩全部停止，验收只剩 Superagent 自身按任务书执行。任何等级都要求证据真实，等级只决定验收做到多深。

**数量上限**默认 5（可在设置里改 1–20）。超出后自动淘汰**最旧的已完成**子代理：已成功/失败/中断的，以及从未开工就闲置的都算已完成；运行中、已保护（🔒）、正在查看的不会被删，手动删除始终可用。

**僵尸兜底**：开了工（有 `time.busy`）但既没有结果也没有 `time.idle` 的子会话（典型是被 shutdown 打断）永远进不了淘汰候选，超过 6 小时按僵死处理，放回淘汰候选。

**子代理行的 `ctx N`**：显示最近一次 assistant 调用的输入侧规模（`input` + `cache read/write`），代表这一次实际送进模型的提示大小，不是累计 token 成本；已完成的 compact 之前的旧记录会跳过，compact 后新一步的读数随之下降。没有用量数据时整段不显示。警示阈值默认 300K tokens；模型有已知上下文窗口时取 `min(300K, floor(window × 0.8))`，窗口读不到就沿用 300K。严格超过阈值才把读数染成警示色并追加 `⚠`，恰好等于阈值不警示。

**超长上下文自动压缩**：服务端每 5 分钟随探针一起扫描，子代理当前上下文严格超过上述阈值时，直接对该子会话发起原生 compact（`session.compact`，与手动点行菜单「压缩上下文」同一操作），保持当前模型、不发提示词、不打断子代理本身；compact 请求本身产生的压缩消息是预期行为。每个子代理只自动压缩一次；compact 生效后长度较上次下降 ≥30% 会清掉去重记录，允许再次触发。压缩失败只记日志（`ctx-compact-failed`）、声明保留不重试轰炸。某个 root 停用协作时只跳过该 root 的家族，其他 root 照常扫描。阈值只决定触发时机，不改变验收等级；任务仍需要长上下文时可以直接续跑。

**删除 Subagent**：行操作菜单里的「删除 Subagent」只删除该子会话及其上下文，确认框写明子会话与上下文都会被删除且不可恢复；删除后不重建、不再发新任务、不导出上下文。需要继续同一任务时优先 steer 续跑或 compact，只有不再需要该上下文时才删除，删除前先与用户确认。

**默认模型批量应用**：默认模型选「指定模型」后，当前 root 下所有未保护、未单独指定策略的子代理都会切到该 provider/model/variant（含 variant），不再只影响此后新建的子代理；选「跟随会话」时这批子代理跟随 root 当前模型，root 之后换模型会同步它们；选「自动」没有唯一模型，只影响后续自动分配，不改动已有子代理。子代理单独设为「指定模型」是手动选择，默认模型不会覆盖它；单独设为「跟随会话」继续跟随 root，单独设为「自动」继续自动管理。首次挂载或 reload 只把 fixed 默认应用到默认设置之后新建的子代理，不批量切换旧会话。未指定 variant 与字面 `default` 视为同模型，不重复切换。批量切换串行执行，运行中的子代理先中断、等执行停下再切换并续跑，失败逐个报出，不会静默。默认批量同步不是显式旗舰委派：目标与 root 同模型也不做旗舰预检、不占旗舰名额。显式 `input.model` 委派优先于默认模型：该子代理带有效 `superagent.model-delegation` 标记时，默认模型同步与 root 换模型都跳过它，直到它切到其他模型；默认模型只作用于未显式指定模型的子代理。

**备用模型**：同一会话内连续 3 次限额类失败（阈值可调 1–10）后自动切到备用模型，每个会话只切一次、切完不回切；切换时子代理上限同步降一档（5→4→3→2，下限 2），不自动恢复。

**critic 他监督复核**：默认关闭。开启后，子代理完成时由一个独立会话复核它的报告，结果写 `~/.local/state/opencode/superagent/critic/`，失败只记日志、不影响主流程。

**超时状态探针**：每 5 分钟扫一次，子代理连续运行满 30 分钟仍未收尾的，发一条只要求回一行状态的探针，避免主代理一直干等；每个会话只探一次。

**协作模式总开关**：下面这些行为可以按 Superagent family root 分别停用——硬拦截、限额自动切换、critic 复核、超时探针、超长上下文自动压缩。开关值存在该 root 会话自己的 `superagent.collab-enabled` 指令条目里（`"true"` / `"false"`），不读写全局配置文件。root A 停用不影响 root B；root 的所有子代理随本 root 停用，切到哪个 root 面板就显示哪个 root 的状态。条目缺省、值不合法或读取失败都按启用处理。停用后右栏只剩一行「agents协作已停用 · 本会话 · 左键开启」，点一下只把当前 root 写回启用。停用不会改动 `opencode.jsonc`，也不会清理已写入会话的其他指令条目——提示词存量会保留，重新开启后照常使用。

## 内置 Skills

Server 入口随插件自动注册三个原生 Skills，不需要复制 skill 目录或额外安装：

| Skill | 用途 |
| --- | --- |
| `superagent-orchestration` | 派工判断：是否适合 Flash、何时默认新建并行或合并、七字段契约、并行拆分与耦合合并、续跑边界与 interrupt 语义、能力升级与限额切换的边界、同款旗舰子代理授权 |
| `superagent-acceptance` | 按子代理实际 L0–L4 等级选择验收深度，核对证据、截图、复跑与 critic 复核 |
| `superagent-context` | ctx 口径与阈值、compact/续跑取舍、何时删除 Subagent |

OpenCode 按技能描述在匹配场景按需加载。若已存在同名用户技能，注册时按 id 判重跳过，不覆盖用户版本。单个技能或整个注册服务失败只记 `skills-register-failed`，不阻断插件其他能力。

## 状态回传

每次子代理派发都有可追踪的状态，Superagent 当场就能看到「派了什么、子会话是谁、后台还有什么在跑」，结束后也会收到明确的完成确认。

**派发回执**：协作开启的调用，工具结果末尾会附一行回执（`[superagent] dispatch=ok · mode=new · child=ses_x · state=running · model=p/m · interrupt=not-needed · evicted=ses_y · 完成后自动通知`）。字段含义：`dispatch` 派发是否成功、`mode` 新建还是续跑、`child` 子会话 ID、`state` 子会话当前状态、`model` 显式指定的模型、`interrupt` 续跑前置中断结果（`not-needed` / `interrupted` / `off` / `failed`）、`evicted` 本次淘汰的子会话。判定失败但已放行（fail-open）时追加 `warning=`，不再静默。

**完成通知**：子代理完成、失败或中断时，插件向主会话投递一条 `<subagent sessionID="..." state="completed|error|cancelled">…</subagent>` 通知，正文是子代理的最终输出（超长截断）。原生已经通知过的子代理不重复发。

**后台任务通知**：子代理回合已结束、但它拉起的后台进程仍在跑时（典型是 Windows 侧的后台编排器），插件会通知主会话「仍有 N 个后台任务在跑」并列出任务清单，同时在子会话写运行状态标记；后台任务结束后再补一条「后台任务已全部结束」的通知。面板对应显示 `⏳ 后台 N 个任务`。

**状态监测开关**：`superagent.status-watch`（root 级，默认开启，只有明确的 `false` 才停用）控制这套回传。停用后不登记监测、不做周期对账、不补发提醒；面板「agents协作设置 → 子代理状态监测」可切换。

**周期对账（兜底）**：有监测中的子代理时，每 60 秒对账一次：子代理已停却一直没收到完成确认时补发一次提醒（`[superagent] 监测到子代理 ses_x 已停止（completed），但此前未收到完成确认。请验收或续跑。`）。每个子代理每个状态只提醒一次，总提醒上限 2 次；主会话正在运行时不打扰，等它空闲再说。事件驱动是主路径，对账只是兜底。

**判定日志**：`hook.log` 里的 `status-*` 事件记录全过程——`status-dispatch`（派发回执与中断结果）、`status-background`（后台任务通知）、`status-completed`（完成通知）、`status-reminder`（对账提醒）、`status-notify-failed`（通知失败）、`status-watch-disabled`（开关停用）。

## 设置项

点击面板标题「agents协作」打开设置：

| 设置项 | 作用 |
| --- | --- |
| 协作模式总开关 | 仅当前 root 会话；停用后该 root 的拦截、切换、复核、探针、上下文自动压缩全部停止，面板只留一行可点回，其他 root 不受影响 |
| 监管力度 | root 默认 L0–L4，或恢复默认 L2 |
| 当前会话策略 | 报告风格（简洁/详细）、会话补充提示词 |
| 最大子代理数量 | 1–20，超出自动淘汰最旧已完成 |
| 旗舰子代理数量 | 0–20，默认 2；只约束显式指定与 root 同款模型的委派（其余同模型子代理不受限），并继续受子代理总上限约束 |
| 任务分配微调提示词 | 追加到派工协议后面的编排偏好 |
| 当前任务补充提示词 | 只对当前任务生效的补充说明 |
| 子代理默认模型 | 自动 / 跟随会话 / 指定模型 / 配置全局自动模型 |
| Superagent 备用模型 | 主会话限额失败后的落点 |
| Subagent 备用模型 | 子代理限额失败后的落点 |
| 限额自动切换备用模型 | 开关 + 连续失败次数 |
| critic 他监督复核 | 开关 |
| 子代理状态监测 | 开关；关闭后不登记监测、不做周期对账、不补发完成/后台/提醒通知 |
| 配置全局自动模型 | 所有会话共用的自动模型候选列表 |
| 恢复默认编排策略 | 把默认值重新写入当前会话 |

子代理行上的 `Lx` 徽标：点击可单独固定该子代理的监管等级（root 上的徽标打开最近 20 条监管审计）；点标题打开行操作菜单：修改模型、打开子会话、压缩上下文、保护/取消保护、删除 Subagent（只删会话与上下文，不可恢复）。

**保护**（🔒）挡住两件事：子代理不会被自动淘汰，模型也不会被修改（默认模型批量同步与 root 换模型都跳过它，手动改模型会被拒绝并提示先取消保护）；取消保护后才可改。手动删除始终允许。

## 已知限制

- **官方 2.2.5 的 watcher 有盲区**：改了插件文件（含 `index.tsx`/`server.ts`）不会热更新，必须执行 `opencode reload`。
- **`ui.model.select` 尚未发布**：模型选择用的是自绘 fallback 选择器，样式已对齐原生；官方发布后自动走原生选择器。
- **宿主多实例 dispose 不完全**：reload 后旧订阅可能残留。插件用 `critic-claims/`、`probe-claims/` 落盘声明去重，保证复核与探针不会重复执行，副作用是极端情况下会留下空的声明目录。
- **状态回传是插件侧补的**：原生只在后台派发完成时通知一次；插件的完成通知与提醒都靠判重避免重复刷屏，但极端情况下（宿主事件丢失）仍可能与原生通知各发一次。
- **critic 复核会临时占一个名额**：复核会话挂在 root 下，复核期间该名额被占用（它本身不参与淘汰）。
- **探针的 root 配置有实例内缓存**：新加的配置要 `opencode reload` 后才被探针看到。
- **僵尸兜底按 6 小时算**：真有超过 6 小时的长跑子代理，可能被误判为僵死而释放名额。

## 开发

```sh
bun install
sh build.sh     # 校验入口 + 产出 dist/index.js
bun test        # 全部单元测试与接线测试
bun test bench/test  # 评测台 runner 单测
```

**端到端评测**：`bench/` 是可重复运行的 OpenCode 真模型 A/B 评测台，固定 root 模型 `zhipuai-coding-plan/glm-5.3`、普通子代理固定 `alibaba-cn/deepseek-v4.1-flash-1017`，以隐藏测试确定性判分。任务集、变体、参数与结果口径见 `bench/README.md`。

```sh
bun bench/run.ts --dry-run --variants flagship,base,candidate --tasks all --reps 3 --seed 7
```

- `build.sh` 是**入口守卫**：`package.json` 的 `exports["./tui"]` 必须是 `./index.tsx`，否则直接失败——运行时只认源码入口，改到 `dist` 会让面板失效。
- `dist/` 只是构建校验产物，运行时从不加载，因此不进 npm 包。
- `bunfig.toml` 里的 `@opentui/solid/preload` 是测试 preload，删掉 `bun test` 会起不来。
- **跨平台不要复制 `node_modules` 和 `bun.lock`**：两个平台的依赖树不同，目标机器上重新 `bun install` 即可。
- Windows 下用 Git Bash 跑 `sh build.sh`；`bun test` 与 Linux 一致。

## 兼容

- OpenCode **≥ 2.2.5**（目前只在 2.2.5 上实测，更低版本未验证）。
- 版本 **0.2.2**，0.x 阶段不承诺存储格式兼容。升级前建议清掉旧状态：删除 `~/.local/state/opencode/superagent/` 与 `~/.local/state/opencode/latest/tui/plugin.superagent.agents.*.json`（会丢设置与审计记录）。
- 设置与审计都落在本地状态目录，不联网、不上传。

## 卸载

删掉插件目录（或从 `opencode.jsonc` 的 `plugins` 里移除该项），然后 `opencode reload`。需要一并清理状态时，删除 `~/.local/state/opencode/superagent/` 和对应的 `plugin.superagent.agents.*.json`。