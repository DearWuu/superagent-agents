# AGENTS.md

## 项目概述
`superagent-agents` 是 OpenCode 的 Superagent / Subagent 编排插件，使用 Bun、TypeScript/TSX、Solid 和 OpenTUI。仓库扁平，源码与测试同放根目录；用户行为与安装参数见 `README.md`，端到端评测资产见 `bench/README.md`。两个独立入口（`package.json` 的 `exports`）：

- TUI `./tui` → `index.tsx`：右栏面板、设置、模型选择、子代理操作、本地存储。
- Server `./server` → `server.ts`：子代理/旗舰上限、淘汰、限额切换、critic 接线、超时探针、上下文提醒、原生 Skills 注册。

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
| `index.tsx` | TUI 入口、`SidebarAgents`、设置与交互、面板格式化 |
| `server.ts` | Server 入口、OpenCode 钩子与事件接线、限制/切换/扫描状态机 |
| `agent-tree.ts` / `model-policy.ts` | 会话树构建与排序；模型引用、可用性校验与选择策略 |
| `oversight.ts` / `context-policy.ts` | L0–L4 报告与验收协议；ctx 阈值 `min(300K, floor(window×0.8))` |
| `flagship.ts` / `flagship-admission.ts` | 同款旗舰身份判定、默认 2 / 0..20 / 总上限收敛、准入与淘汰候选 |
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
4. **Server 辅助能力不得打挂主流程。** 查询异常按 fail-open 处理，只有明确的数量上限拒绝才阻止 `subagent` 调用；日志、critic、探针、上下文提醒、Skills 注册失败只记录。新增钩子、事件订阅和定时器必须在 dispose 中清理。
5. **保持两端语义一致。** 活跃状态优先于残留 outcome；上下文用量取 compact 后最近一次 assistant 的输入侧 tokens（input + cache read/write），阈值默认 300K、已知窗口取 `min(300K, floor(window×0.8))`，严格超过才警示；长运行与探针共用 30 分钟语义。
6. **旗舰与淘汰都有破坏性。** 旗舰身份优先看创建时元数据标记，root 切模型不清洗旧标记；旗舰超限只淘汰最旧已完成旗舰，运行中、正在 steer、已保护、TUI 正在查看的子会话都不删；critic 会话不占普通子代理名额；修改候选条件或计数公式时补边界与并发测试。
7. **默认模型批量与保护。** fixed 默认模型变更、inherit 跟随 root 都批量切到当前 root 下所有未保护且非 auto 子代理（保留 variant），auto 不批量；首次挂载/reload 不批量切旧会话。运行中先中断再切换并续跑，串行且逐项报错；目标与 root 同模型时先做旗舰上限预检，超限整次不执行。保护名单同时挡自动淘汰与模型批量修改，手动改受保护子代理模型要拒绝，手动删除始终允许。删除只移除子会话与上下文，不重建、不发新任务。

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