# AGENTS.md
## 项目概述
`superagent-agents` 是 OpenCode 的 Superagent / Subagent 编排插件，使用 Bun、TypeScript/TSX、Solid 和 OpenTUI。仓库扁平，源码与测试同放根目录；用户行为与安装参数见 `README.md`，端到端评测资产见 `bench/README.md`。两个独立入口（`package.json` 的 `exports`）：

- TUI `./tui` → `index.tsx`：右栏面板、设置、模型选择、子代理操作、本地存储。
- Server `./server` → `server.ts`：子代理/旗舰上限、淘汰、限额切换、critic 接线、超时探针、上下文自动压缩、原生 Skills 注册。
## 常用命令
```sh
bun install
bun test                    # 全部测试
bun test <file>.test.ts     # 单个测试文件
bun test bench/test         # 评测台 runner 单测
bun run build               # 等价于 sh build.sh；Windows 用 Git Bash 跑
```
`bunfig.toml` 的 `@opentui/solid/preload` 是 TSX 测试必需的 preload，不要删除。
## 模块职责

| 文件 | 职责 |
| --- | --- |
| `index.tsx` / `panel-notify.ts` | TUI 入口、`SidebarAgents`、设置与交互、面板格式化；面板手动操作回传文案与投递 |
| `server.ts` | Server 入口、OpenCode 钩子与事件接线、限制/切换/扫描状态机 |
| `agent-tree.ts` / `model-policy.ts` | 会话树构建与排序；模型引用、可用性校验与选择策略 |
| `oversight.ts` / `context-policy.ts` | L0–L4 报告/验收协议（Subagent 只收报告协议，Superagent 条目只收验收动作）；ctx 阈值 `min(300K, floor(window×0.8))` |
| `flagship.ts` / `flagship-admission.ts` | 同款旗舰身份判定、默认 0 / 0..20 / 总上限收敛、准入、淘汰候选与降额切换选择 |
| `model-delegation.ts` | 显式 `input.model` 委派标记：来源、写入与「当前模型仍匹配才有效」判定 |
| `subagent-status.ts` / `subagent-evict.ts` | 状态回传：派发台账与回执、后台任务识别、完成/后台/提醒通知文案与判重、看护与周期对账；子代理收尾后按上限淘汰超额 |
| `skills.ts` | 三个内置原生 Skill 的静态内容与 id，供 server 注册 |
| `session-scope.ts` / `storage-migration.ts` | 按 root 隔离的持久化设置与旧格式迁移 |
| `subagent-limit.ts` / `run-duration.ts` | TUI 侧淘汰计划；运行状态、时长与长运行展示 |
| `critic.ts` | 独立只读复核、结论解析与 JSONL 审计；审计目录与监管审计同认 `SUPERAGENT_STATE_DIR` |
| `bench/` | 端到端 A/B 评测台（固定 GLM root + Flash 子代理），入口与口径见其 README |

可判定逻辑放纯函数模块，入口文件只保留宿主 API 接线与 UI 组合；新增随包发布的运行时代码时同步检查 `package.json` 的 `files` 白名单。
## 必须保持的约束

1. **运行时加载源码入口。** `exports["./tui"]` 必须保持 `./index.tsx`；`build.sh` 是入口与产物守卫，`dist/index.js` 只是构建校验产物。
2. **设置按 root 隔离。** 会话树配置放在 `roots[rootSessionID]`；只有全局自动模型列表等明确共享的数据放在 root 外，读写和迁移不能跨 root 泄漏。
3. **两端共享配置走指令条目。** Server 读不到 TUI storage；上限、旗舰上限、保护名单、协作开关、备用模型等经 root 链上的 `superagent.*` instruction entries 传递，改动时同步检查两端读取路径。上限只认链上 `superagent.max-subagents` 条目并向上继承；派工前服务端按默认策略注入模型（fixed/inherit 注入，auto/unset 不注入；显式委派与有效标记豁免，目标不可用则不注入并回执告警，fail-open）。限额备用为窗口内累计限额失败达到阈值立即切换，否则窗口到期切换，窗口内任一成功即取消。
4. **Server 辅助能力不得打挂主流程。** 查询异常按 fail-open 处理，只有明确的数量上限拒绝才阻止 `subagent` 调用；日志、critic、探针、上下文自动压缩、Skills 注册失败只记录。新增钩子、事件订阅和定时器必须在 dispose 中清理。
5. **保持两端语义一致。** 活跃状态优先于残留 outcome；活跃＝有 `busy` 且（`idle` 缺省或 `idle < busy`），每个新忙碌周期可再探一次；上下文用量取 compact 后最近一次 assistant 的输入侧 tokens（input + cache read/write），阈值默认 300K、已知窗口取 `min(300K, floor(window×0.8))`，严格超过才警示；长运行与探针共用 30 分钟语义，探针要求先一行报状态再继续剩余工作。
6. **旗舰与淘汰都有破坏性。** 旗舰只约束 Superagent 显式指定与 root 同款模型的委派；身份只认显式委派成功后写入、带 `source: "explicit-subagent-delegation"` 来源的元数据标记（无来源的历史标记按普通处理），root 切模型不清洗旧标记，子代理当前模型与标记模型不一致时标记过期。缺省 input、agent 默认、inherit/fixed/手动/F2 改到的同模型都是普通子代理，不占旗舰名额。新建显式旗舰超限只淘汰最旧已完成旗舰，运行中、正在 steer、已保护、TUI 正在查看的子会话都不删；用户在面板调小有效上限时，现有超额旗舰不删，保留较新的 N 个、最旧先按子代理默认模型串行切换（fixed 用默认模型，inherit 用 root 模型，auto 无唯一目标不猜），目标缺失/不可用/同模型/失败跳过并提示，额度不回滚；critic 身份只认 `metadata["superagent.critic"] === true`（标题不作依据），不占普通子代理名额；子代理完成后即按上限淘汰最旧的已完成子代理，不必等下一次派发才腾位；修改候选条件或计数公式时补边界与并发测试。
7. **默认模型批量与保护。** fixed 默认模型变更、inherit 跟随 root 都批量切到当前 root 下所有普通非归档直属子代理（保留 variant；运行中直接切换、当前步骤继续；逐项报错）；auto 默认无唯一目标不批量；kept 只防自动淘汰、per-child 策略只管后续分配，都不阻止默认同步；critic 始终排除；唯一业务豁免是有效显式 `input.model` 委派（marker 与当前模型匹配），无标记或已切走照常覆盖。首次挂载/reload 只把 fixed 默认应用到默认设置之后新建的子代理；同步状态按 root 隔离，A→B→A 不重复批量，同一 root 同步中收到新目标只记最新 pending 并在本轮后接续，不同 root 互不阻塞。批量同步不做旗舰预检、不写旗舰身份。派工时按策略注入模型只作用于该次派工（新建或续跑），与批量同步是两条独立路径，互不替代。保护名单挡自动淘汰与手动改模型，手动删除始终允许。删除只移除子会话与上下文，不重建、不发新任务。
8. **编排契约与 interrupt。** 无关联的独立任务默认新建并尽量并行，能独立验收、上下文可独立携带的任务尽量拆分；同文件或强耦合、并行会冲突的任务合并；续跑只用于同一模块的后续修改、返工与迭代；同一目标禁止重复派工，并行不得绕过子代理总上限与旗舰上限。续跑运行中的子代理时默认排队，不打断当前运行，由原生 steer 排队投递；只有显式传 `interrupt: true` 才先中断当前运行、等它停下再发送新任务；`interrupt: false` 与缺省行为相同。派工成功只认 subagent 工具成功回执，没收到回执不得称已派出或并行中；状态不确定最多做一次有界只读核实，禁止连续轮询；报告时间取真实工具或通知时间，取不到写「未知」。子代理只向 Superagent 汇报：root 协作开启时，有 `parentID` 的会话调 `question` 或嵌套 `subagent` 一律拒绝（后者记 `nested-dispatch-denied`），问题与建议写进报告「待 Superagent 裁决」栏并置 blocked，由 Superagent 裁决后续跑下达。`skills.ts`、`README.md` 与本文件保持同口径。
9. **状态必须回传、通知必须判重、看护不得阻塞。** 派发要有回执（模式、子会话、状态、中断结果），完成/失败/中断与后台任务都要通知主会话；原生已通知过的不重复发（判重看 `metadata.source` + `childID` 与正文 `<subagent sessionID=...>`，工具结果正文里的标签同样算数；正文标明后台仍在跑、标签仍为 running 的卡不算终态）；同一代后台任务只提醒一次，之后只更新运行标记；对账提醒等两拍（首拍只 arm），措辞允许「如已知晓可忽略」。子代理回合已结束但后台任务仍在跑时必须显式告诉主会话。看护、通知与周期对账全部异步执行，不阻塞工具钩子与事件消费；周期对账只是兜底（60s、每子代理每状态 1 次、总上限 2 次），开关 `superagent.status-watch` 停用后不登记监测、不走表、不提醒。面板上的手动操作（删除/压缩/保护/监管等级/协作开关/数量上限/单个子代理切模型/默认模型策略/报告风格与提示词等有副作用设置）必须回传 root 并写明是用户手动做的，与状态监测开关无关；非立即操作在 800ms 窗口内合并成一条 synthetic，delete/compact/collab/model 先冲刷窗口再单独投递，全部以 `queue` 投递（不 steer 不唤醒），失败只提示不回滚，成功才记录；面板或插件主动切模型一律直接调用官方 `session.switchModel`（官方语义：不中断运行中的会话，只作用于后续 provider 回合；当前步骤继续，后续步骤使用新模型），不续跑、不写指令标记；真正的中断仍按 `cancelled` 收尾。
## 代码与测试约定
- ESM、双引号、两个空格缩进、不加分号；相对导入保持现有无扩展名形式。
- 新的 OpenTUI TSX 文件顶部添加 `/** @jsxImportSource @opentui/solid */`。
- 测试用 `bun:test`，`*.test.ts` / `*.test.tsx` 与源码同目录；优先覆盖纯逻辑，再用假 `ctx` 驱动真实 `setup()` 做接线测试。
- 导入 `index.tsx` 前先 `mock.module("@opencode/plugin/tui", ...)`，再动态 `await import("./index")`。
- OpenTUI 组件测试用 `testRender`，在 `finally` 中销毁 renderer；异步帧用有超时的等待。
- 文件状态测试用临时目录，隔离 `SUPERAGENT_STATE_DIR`、`SUPERAGENT_HOOK_LOG`、`XDG_STATE_HOME` 等变量。
## 验证与运行调试

功能修改后至少运行 `bun test` 与 `bun run build`；UI 修改另用现有离屏渲染测试检查真实文本帧。插件文件不会可靠热更新，手动验证前执行 `opencode reload` 或重启 OpenCode。

Server 判定日志默认写入 `~/.local/state/opencode/superagent/hook.log`，可用 `SUPERAGENT_HOOK_LOG` 改路径、`SUPERAGENT_STATE_DIR` 隔离整个状态目录；critic 审计、声明文件等状态也位于该状态树中。安装是否完整需同时确认 TUI 面板与 Server 的 `setup` 日志存在。

## 本地开发隔离

在线 plugins 目录（`~/.config/opencode/plugins/superagent-agents` 及各机器镜像）只存放已验收代码，不直接在其中开发、安装依赖或跑构建。开发在 `/tmp/opencode` 等 plugins 扫描范围外的 git worktree 里进行，依赖安装、测试、构建与真实加载验证（独立 `XDG_CONFIG_HOME` + 独立 OpenCode 实例，插件显式指向开发目录）都在隔离环境完成。验收通过后才把在线 main fast-forward 到开发分支，并同步 core/Windows 镜像。
