# superagent-agents

OpenCode 的 Superagent / Subagent 编排插件：把「主代理只做设计和验收、子代理并行实现」这套协作方式做成可操作的右栏面板，并在服务端兜住子代理数量、失败切换与超时卡死。

- TUI 入口（`./tui` → `index.tsx`）：右栏「agents协作」面板，展示子代理树、状态、模型与监管等级，点标题打开设置、点行看子代理操作。
- Server 入口（`./server` → `server.ts`）：子代理数量上限、限额自动切换备用模型、critic 复核、超时状态探针，全部判定写入 `hook.log`。

两个入口共用一份存储，装好即用，不需要额外配置。

## 安装

### 方式一：GitHub 仓库（推荐）

```sh
opencode plugin add github:DearWuu/superagent-agents
```

或在 `opencode.jsonc` 里直接写：

```jsonc
{
  "plugins": ["github:DearWuu/superagent-agents"]
}
```

OpenCode 启动时由 Bun 从 GitHub 拉取仓库、装进自己的缓存（`~/.cache/opencode/`），随后 `opencode reload` 或重启即生效。升级用 `opencode plugin update`。

需要固定版本时在 spec 后加 ref（分支、tag 或 commit 都行）：

```sh
opencode plugin add github:DearWuu/superagent-agents#v0.1.0
```

```jsonc
{ "plugins": ["github:DearWuu/superagent-agents#v0.1.0"] }
```

访问不了 GitHub 的环境用方式二。

### 方式二：目录插件（离线可用）

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

### 方式三：npm 包（尚未发布到 npm）

GitHub 是当前的分发方式，npm 包还没发布；下面写法等包上线后才可用。

```jsonc
{
  "plugins": ["superagent-agents@0.1.0"]
}
```

以包名引用时，OpenCode 用 Bun 在启动时把包装进自己的缓存（`~/.cache/opencode/` 下），因此该包必须能从本机 bun 的 registry 取到；离线或内网环境请用方式二。

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

   有面板、没有这一行 = 只有 TUI，没有服务端钩子（限额、切换、复核、探针都不生效）。
3. **判定日志有 setup**：`~/.local/state/opencode/superagent/hook.log` 出现

   ```json
   {"plugin":"superagent-agents-hardlimit","event":"setup","decision":"allow"}
   ```

   该文件可用环境变量 `SUPERAGENT_HOOK_LOG` 改到别处；排查「限额不生效」「为什么不切换模型」都先看这里。

## 概念

**Superagent**（主代理）负责分析需求、拆解任务、方案设计、写任务书与验收标准、派工和验收，不自己写实现代码；**Subagent** 只按任务书实现并回报。面板就是这两者的调度台。

**监管等级 L0–L4** 只决定子代理报告要写到多细，不限制它能做什么：

| 等级 | 名称 | 必填章节（逐级累加） | 交付节奏 |
| --- | --- | --- | --- |
| L0 | 结果级 | 改动、测试、风险 | 完成/失败时一次 |
| L1 | 摘要级 | + 执行命令与 exit code、阶段小结 | 完成/失败时一次 |
| L2 | 证据级（默认） | + 测试明细、读过的文件 path:行号、失败详情 | 完成/失败时一次 |
| L3 | 全量级 | + 命令完整输出、关键代码摘录、每文件改动理由 | 结束总报告 + 中途简报 |
| L4 | 审计级 | + 每步动机、假设清单、考虑过又放弃的方案 | 每步汇报 + 结束总报告 |

等级按会话固定，可对整个 root 设默认、也可只固定某个子代理（子代理未固定时跟随默认）。

**数量上限**默认 5（可在设置里改 1–20）。超出后自动淘汰**最旧的已完成**子代理：已成功/失败/中断的，以及从未开工就闲置的都算已完成；运行中、已保护（🔒）、正在查看的不会被删，手动删除始终可用。

**僵尸兜底**：开了工（有 `time.busy`）但既没有结果也没有 `time.idle` 的子会话（典型是被 shutdown 打断）永远进不了淘汰候选，超过 6 小时按僵死处理，放回淘汰候选。

**备用模型**：同一会话内连续 3 次限额类失败（阈值可调 1–10）后自动切到备用模型，每个会话只切一次、切完不回切；切换时子代理上限同步降一档（5→4→3→2，下限 2），不自动恢复。

**critic 他监督复核**：默认关闭。开启后，子代理完成时由一个独立会话复核它的报告，结果写 `~/.local/state/opencode/superagent/critic/`，失败只记日志、不影响主流程。

**超时状态探针**：每 5 分钟扫一次，子代理连续运行满 30 分钟仍未收尾的，发一条只要求回一行状态的探针，避免主代理一直干等；每个会话只探一次。

## 设置项

点击面板标题「agents协作」打开设置：

| 设置项 | 作用 |
| --- | --- |
| 监管力度 | root 默认 L0–L4，或恢复默认 L2 |
| 当前会话策略 | 报告风格（简洁/详细）、会话补充提示词 |
| 最大子代理数量 | 1–20，超出自动淘汰最旧已完成 |
| 任务分配微调提示词 | 追加到派工协议后面的编排偏好 |
| 当前任务补充提示词 | 只对当前任务生效的补充说明 |
| 子代理默认模型 | 自动 / 跟随会话 / 指定模型 / 配置全局自动模型 |
| Superagent 备用模型 | 主会话限额失败后的落点 |
| Subagent 备用模型 | 子代理限额失败后的落点 |
| 限额自动切换备用模型 | 开关 + 连续失败次数 |
| critic 他监督复核 | 开关 |
| 配置全局自动模型 | 所有会话共用的自动模型候选列表 |
| 恢复默认编排策略 | 把默认值重新写入当前会话 |

子代理行上的 `Lx` 徽标：点击可单独固定该子代理的监管等级（root 上的徽标打开最近 20 条监管审计）；点标题打开行操作菜单：修改模型、打开子会话、压缩上下文、保护/取消保护、删除并重建。

## 已知限制

- **官方 2.2.5 的 watcher 有盲区**：改了插件文件（含 `index.tsx`/`server.ts`）不会热更新，必须执行 `opencode reload`。
- **`ui.model.select` 尚未发布**：模型选择用的是自绘 fallback 选择器，样式已对齐原生；官方发布后自动走原生选择器。
- **宿主多实例 dispose 不完全**：reload 后旧订阅可能残留。插件用 `critic-claims/`、`probe-claims/` 落盘声明去重，保证复核与探针不会重复执行，副作用是极端情况下会留下空的声明目录。
- **critic 复核会临时占一个名额**：复核会话挂在 root 下，复核期间该名额被占用（它本身不参与淘汰）。
- **探针的 root 配置有实例内缓存**：新加的配置要 `opencode reload` 后才被探针看到。
- **僵尸兜底按 6 小时算**：真有超过 6 小时的长跑子代理，可能被误判为僵死而释放名额。

## 开发

```sh
bun install
sh build.sh     # 校验入口 + 产出 dist/index.js
bun test        # 6 个测试文件，114 个用例
```

- `build.sh` 是**入口守卫**：`package.json` 的 `exports["./tui"]` 必须是 `./index.tsx`，否则直接失败——运行时只认源码入口，改到 `dist` 会让面板失效。
- `dist/` 只是构建校验产物，运行时从不加载，因此不进 npm 包。
- `bunfig.toml` 里的 `@opentui/solid/preload` 是测试 preload，删掉 `bun test` 会起不来。
- **跨平台不要复制 `node_modules` 和 `bun.lock`**：两个平台的依赖树不同，目标机器上重新 `bun install` 即可。
- Windows 下用 Git Bash 跑 `sh build.sh`；`bun test` 与 Linux 一致。

## 兼容

- OpenCode **≥ 2.2.5**（目前只在 2.2.5 上实测，更低版本未验证）。
- 版本 **0.1.0**，0.x 阶段不承诺存储格式兼容。升级前建议清掉旧状态：删除 `~/.local/state/opencode/superagent/` 与 `~/.local/state/opencode/latest/tui/plugin.superagent.agents.*.json`（会丢设置与审计记录）。
- 设置与审计都落在本地状态目录，不联网、不上传。

## 卸载

删掉插件目录（或从 `opencode.jsonc` 的 `plugins` 里移除该项），然后 `opencode reload`。需要一并清理状态时，删除 `~/.local/state/opencode/superagent/` 和对应的 `plugin.superagent.agents.*.json`。