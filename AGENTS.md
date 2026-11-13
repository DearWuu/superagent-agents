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
| `oversight.ts` / `context-policy.ts` | L0–L4 报告与验收协议；ctx 阈值 `min(300K, floor(window×0.8))` |
| `flagship.ts` / `flagship-admission.ts` | 同款旗舰身份判定、默认 2 / 0..20 / 总上限收敛、准入与淘汰候选 |
| `model-delegation.ts` | 显式 `input.model` 委派标记：来源、写入与「当前模型仍匹配才有效」判定 |
| `subagent-status.ts` | 状态回传：派发台账与回执、后台任务识别、完成/后台/提醒通知文案与判重、看护与周期对账 |
| `skills.ts` | 三个内置原生 Skill 的静态内容与 id，供 server 注册 |
| `session-scope.ts` / `storage-migration.ts` | 按 root 隔离的持久化设置与旧格式迁移 |
| `subagent-limit.ts` / `run-duration.ts` | TUI 侧淘汰计划；运行状态、时长与长运行展示 |
| `critic.ts` | 独立只读复核、结论解析与 JSONL 审计 |
| `bench/` | 端到端 A/B 评测台（固定 GLM root + Flash 子代理），入口与口径见其 README |

可判定逻辑放纯函数模块，入口文件只保留宿主 API 接线与 UI 组合；新增随包发布的运行时代码时同步检查 `package.json` 的 `files` 白名单。
## 必须保持的约束

1. **运行时加载源码入口。** `exports["./tui"]` 必须保持 `./index.tsx`；`build.sh` 是入口与产物守卫，`dist/index.js` 只是构建校验产物。
2. **设置按 root 隔离。** 会话树配置放在 `roots[rootSessionID]`；只有全局自动模型列表等明确共享的数据放在 root 外，读写和迁移不能跨 root 泄漏。
3. **两端共享配置走指令条目。** Server 读不到 TUI storage；上限、旗舰上限、保护名单、协作开关、备用模型等经 root 链上的 `superagent.*` instruction entries 传递，改动时同步检查两端读取路径。
4. **Server 辅助能力不得打挂主流程。** 查询异常按 fail-open 处理，只有明确的数量上限拒绝才阻止 `subagent` 调用；日志、critic、探针、上下文自动压缩、Skills 注册失败只记录。新增钩子、事件订阅和定时器必须在 dispose 中清理。
5. **保持两端语义一致。** 活跃状态优先于残留 outcome；上下文用量取 compact 后最近一次 assistant 的输入侧 tokens（input + cache read/write），阈值默认 300K、已知窗口取 `min(300K, floor(window×0.8))`，严格超过才警示；长运行与探针共用 30 分钟语义。
6. **旗舰与淘汰都有破坏性。** 旗舰只约束 Superagent 显式指定与 root 同款模型的委派；身份只认显式委派成功后写入、带 `source: "explicit-subagent-delegation"` 来源的元数据标记（无来源的历史标记按普通处理），root 切模型不清洗旧标记，子代理当前模型与标记模型不一致时标记过期。缺省 input、agent 默认、inherit/fixed/手动/F2 改到的同模型都是普通子代理，不占旗舰名额。旗舰超限只淘汰最旧已完成旗舰，运行中、正在 steer、已保护、TUI 正在查看的子会话都不删；critic 会话不占普通子代理名额；修改候选条件或计数公式时补边界与并发测试。
7. **默认模型批量与保护。** fixed 默认模型变更、inherit 跟随 root 都批量切到当前 root 下未保护、未单独指定策略且非 auto 子代理（保留 variant），auto 不批量；子代理单独 fixed 是手动选择，默认模型不覆盖。首次挂载/reload 不批量切旧会话。运行中先中断再切换并续跑，串行且逐项报错。批量同步不做旗舰预检、不写旗舰身份。显式 `input.model` 委派优先：该子代理带有效 `superagent.model-delegation` 标记且当前模型仍匹配时，默认同步与 root 换模型都跳过；无标记、来源不符或模型已切走按普通子代理处理。标记在 `session.created` 即按父会话/标题/模型匹配待处理调用提前写入，`execute.after` 成功后再补写。保护名单同时挡自动淘汰与模型批量修改，手动改受保护子代理模型要拒绝，手动删除始终允许。删除只移除子会话与上下文，不重建、不发新任务。
8. **编排契约与 interrupt。** 无关联的独立任务默认新建并尽量并行，能独立验收、上下文可独立携带的任务尽量拆分；同文件或强耦合、并行会冲突的任务合并；续跑只用于同一模块的后续修改、返工与迭代；同一目标禁止重复派工，并行不得绕过子代理总上限与旗舰上限。续跑运行中的子代理时，`interrupt` 默认 `true`，会先中断当前运行再发送新任务；显式传 `interrupt: false` 会保留当前运行并直接 steer。`skills.ts`、`README.md` 与本文件保持同口径。
9. **状态必须回传、通知必须判重、看护不得阻塞。** 派发要有回执（模式、子会话、状态、中断结果），完成/失败/中断与后台任务都要通知主会话；原生已通知过的不重复发（判重看 `metadata.source` + `childID` 与正文 `<subagent sessionID=...>`，工具结果正文里的标签同样算数）；同一代后台任务只提醒一次，之后只更新运行标记；对账提醒等两拍（首拍只 arm），措辞允许「如已知晓可忽略」。子代理回合已结束但后台任务仍在跑时必须显式告诉主会话。看护、通知与周期对账全部异步执行，不阻塞工具钩子与事件消费；周期对账只是兜底（60s、每子代理每状态 1 次、总上限 2 次），开关 `superagent.status-watch` 停用后不登记监测、不走表、不提醒。面板上的手动操作（删除/压缩/保护/监管等级/协作开关/数量上限）必须回传 root 并写明是用户手动做的，受同一开关控制、排队投递、连续操作防抖只发最后一条，失败只提示不回滚；模型切换不单独通知。
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
