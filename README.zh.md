# dsh-agent-adapter

[English](README.md) | **中文**

面向 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）LLM seam 的外部 agent 适配器——一个 host 平面插件，将外部 agent 注册为 DSH LLM provider 路由：

- **codex 半**（`agent-adapter.codex`）：把 [codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server)（stdio 上的换行分隔 JSON-RPC）注册为 DSH provider——由 **codex 本身担任会话的主对话 agent**。
- **ACP 半**（`agent-adapter.acp`）：把 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) agent——OpenCode（`opencode acp`）、Kimi Code CLI（`kimi acp`）、Pi（`pi-acp`）——注册为 DSH provider。

外部 agent 使用**自己的工具、沙盒与权限体系**工作。DSH 侧仍提供：流式消息 UI（含思考与工具调用卡片）、会话持久化与历史回放、中断、标题、token 统计、多会话管理。

两半共享单一设置命名空间 `agent-adapter`（codex 切片在 `agent-adapter.codex`，ACP 切片在 `agent-adapter.acp`）。会话状态持久化在 `$DSH_HOME/llm-codex/sessions.json` / `$DSH_HOME/llm-acp/sessions.json`。

> ACP 半的可行性分析与设计决策（含对 opencode 1.18 的实测数据）见 [docs/feasibility.md](docs/feasibility.md)。

## 安装

插件属 **host 平面**（模型路由跨会话共享），挂到 profile 的 patch 层。

### 通过 `dsh plugin`（常规路径）

```bash
# 1. 构建本包
npm install && npm run build

# 2. 装进 profile（以 web profile 为例）
dsh plugin --profile web add -w file:/path/to/dsh-agent-adapter
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 挂载：

```yaml
- insert:
    # ...已有行...
    - id: agent-adapter
      name: 'dsh-agent-adapter'
```

**重启 harness**。`file:` 依赖由 pnpm 复制到 profile；本包重新构建后，运行 `dsh plugin --profile web install --force` 刷新安装副本。

### 从源码开发

```bash
git clone <本仓库> && cd dsh-agent-adapter
npm install
npm run build              # tsc → lib/ + esbuild 打包 client 设置页
npm run test:unit          # 无需外部二进制
npm run test:integration   # 需要 PATH 上有真实的 `codex` 与 `opencode`
```

从源码安装即上面的 `file:` 安装，指向你的克隆即可。

### 配置（可选）

**无需任何配置即可使用。** PATH 上检测到的 agent（codex、opencode、kimi、pi-acp）默认启用并自动出现在模型选择器里。只有要覆盖默认参数或声明内置表之外的 agent 时才需要写设置——所有键热生效，也可在 Web 设置页 Models 里编辑：

```yaml
agent-adapter:
  codex:
    providers:
      codex:
        command: codex
        args: ['app-server', '--stdio']
        # sandbox / approvalPolicy: 可选的操作员覆盖（见下文）
    # agents:                     # 可选：显式开关已知 codex agent
    #   codex: { enabled: true }
  acp:
    providers:
      opencode:
        displayName: OpenCode
        command: opencode
        args: [acp]
        permissionPolicy: auto    # auto/allow/deny，见下文
    # agents:                     # 可选：显式开关某个已知 agent
    #   kimi: { enabled: false }
```

**已知 agent 自动扫描**：插件内置表覆盖两个半——codex（`codex app-server --stdio`）与各 ACP agent（`opencode acp`、`kimi acp`、`pi-acp`）。在 PATH 上检测到的 agent **默认全部启用**，无需写 `providers`；只有启用的服务才会注册成可用 provider。Web 设置页的 **「Agent 适配 / Agent Adapter」** 栏目列出每个 agent 的检测结果与版本，本机已安装的排在前面、codex 居首；开关逐个启用/停用，写入 `agent-adapter.codex.agents.codex.enabled` / `agent-adapter.acp.agents.<id>.enabled`，即时生效。手动配置的自定义 `providers` 始终启用；与已知 agent 同名的条目作为命令覆盖，但仍受开关控制。codex 的认证走 codex 自身（`codex login` / ChatGPT 账号），本插件不接触 API key。

### 卸载

```bash
dsh plugin --profile web remove dsh-agent-adapter
```

并移除 `cordis.patch.yml` 中的 `agent-adapter` 条目。可选：删除 `agent-adapter:` 设置节与状态文件 `$DSH_HOME/llm-{codex,acp}/sessions.json`（删除 codex 的某条 store 记录会让该会话重新锚定到全新 thread）。

## 权限适配

### codex 半

codex 的审批弹窗**始终桥接到 DSH 审批服务**——由会话自己的审批策略与应答方在 Web UI 中决定；DSH stop 会撤回挂起的问题。桥接 fail-closed：没有活会话或应答方即拒绝。user-input 与 MCP elicitation 弹窗一律拒绝（此侧无交互用户）。

执行沙盒跟随 DSH 会话的权限档，每轮重新求值：

| DSH 权限档 | codex sandbox | approval_policy | approvals_reviewer |
|---|---|---|---|
| 仅可查看 (read-only) | `readOnly`（无网络） | `on-request` | `user`（弹给 DSH 用户） |
| 工作区可写 (workspace-write) | `workspaceWrite`（可写根 = 会话工作区，有网络） | `on-request` | `auto_review` |
| 完全权限 (danger-full-access) | `dangerFullAccess` | `on-request` | `auto_review` |

profile 的 `sandbox` / `approvalPolicy` 是显式操作员覆盖。设 `approvalPolicy: never` 为无人值守模式（codex 全权自决，不经过桥接）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `command` / `args` | —（必填）/ `['app-server', '--stdio']` | codex 可执行文件与参数 |
| `cwd` | harness 进程 cwd | app-server 进程的工作目录；新 thread 创建在 DSH 会话自己的 workspace（header cwd） |
| `env` | 继承 harness 环境 | 追加环境变量 |
| `sandbox` / `approvalPolicy` | 跟随会话推导 | 上表的显式操作员覆盖 |
| `defaultContextWindow` | 272000 | codex 披露真实值之前的上下文上报 |
| `defaultMaxTokens` | 32768 | `resolveModel` 上报的输出上限 |

### ACP 半

`permissionPolicy: auto | allow | deny` 决定 `session/request_permission` 的应答：`auto` 跟随会话自己的权限旋钮（完全权限 → `allow_always`，审批 `never` → deny，其余 → 继承本轮中断信号的审批卡）；`allow` / `deny` 为固定覆盖。交互授权只选 `allow_once`。client 端不声明 `fs` / `terminal` 能力——agent 用自己的工具体系操作文件。

| 字段 | 默认 | 说明 |
|---|---|---|
| `command` / `args` | —（必填） | ACP agent 启动命令，如 `opencode acp` |
| `cwd` | harness 进程 cwd | agent **进程**的工作目录；每个 ACP 会话的项目根目录取自 DSH 会话自己的 workspace |
| `env` | 继承 harness 环境 | 追加环境变量 |
| `permissionPolicy` | `auto` | 见上文 |
| `defaultContextWindow` | 200000 | `usage_update` 学到真实值前的上下文上报（驱动 token 计量与压缩阈值） |
| `defaultMaxTokens` | 32768 | `resolveModel` 上报的默认输出上限 |

### 行为边界（务必阅读）

使用这些 provider 的会话里，**DSH 的 tools / persona / skills / sandbox / approval 全部不作用于 agent 自身的操作**——adapter 忽略 system prompt 与 tools；文件写操作的权限由 agent 自己的配置决定。这正是本插件的意义。DSH 侧的历史仅是展示日志；真实上下文由 agent 自持。

## 实现原理

DSH 的 agent loop 与模型之间只隔一层 `LlmAdapter` 契约（流式吐 chunk 直到 finish）。两个 adapter 在语义上做一次"反转"：DSH loop 是无状态的（每次携带全量历史）；外部 agent 是有状态的（自己保存会话）。

```
DSH agent loop ──stream()──▶ CodexAdapter ──turn/start──▶ codex app-server ──▶ codex agent
                 ◀──StreamChunk──   ◀──item/*, turn/* 通知──

DSH agent loop ──stream()──▶ AcpAdapter ──session/prompt──▶ ACP agent 进程 ──▶ agent
                 ◀──StreamChunk──   ◀──session/update 通知──
```

- **增量投递**：adapter 维护 DSH 会话 ↔ 外部会话的映射（持久化在 `$DSH_HOME/llm-{codex,acp}/sessions.json`），按高水位只把**新增的 `source.kind === 'user'` 人类消息**发给 agent（指纹后缀对齐——取最长尾/首重叠；无法对齐的历史，如 compaction 改写后，降级为只发最新一条）。积压轮次静默执行，只有最后一轮流式输出。`purpose: compaction | session-title` 的请求在本地应答，绝不发给 agent；进程重启后用 `thread/resume` / `session/load` 恢复会话。
- **每个路由一个长驻进程**（惰性拉起，退出后自动重生），说换行分隔的 JSON-RPC——codex app-server 协议（无 `jsonrpc` 字段）或 ACP JSON-RPC 2.0。会话映射为 codex thread（`thread/start` / `thread/resume`）或 ACP session（`session/new` / `session/load`）；映射与水位的持久化是原子的（tmp + rename）。
- **工具镜像（echo 展示工具）**：agent 的工具调用、计划、权限全在 agent 进程内部完成。codex 的 `commandExecution` / `fileChange` / `mcpToolCall` / `webSearch` 项与 ACP 的 `tool_call_update` 会被镜像为 DSH `tool-call` 块，指向注册在该会话 agent scope 上的**展示镜像工具**（`codex_command` / `codex_file_change` / `codex_mcp_tool` / `codex_web_search`，`acp_command` / `acp_file_change` / `acp_tool`）。其 `execute()` 只等待 adapter 预录的 agent 侧结果，**从不执行任何真实操作**；`presentCall` / `presentResult` 渲染意图让 UI 画出终端卡（命令 + 输出 + exit code）和编辑卡（路径 + diff），与 DSH 原生 bash/edit 卡片一致。一个外部 turn 因此可跨多个 DSH step，由 TurnPump 跨 `stream()` 调用组装 StreamChunk；turn 结束时若最后一个 echo 之后没有尾巴内容，该 echo 以 `final` 结算并 `concludeTurn()`，避免多余的空 step。无 DSH 会话身份的一次性调用回退为文本展示块。
- **中断**：DSH stop → codex 侧 `turn/interrupt` / ACP 侧 `session/cancel` notification；回合以 `aborted` finish 结算，已产生的部分输出保留。**零重试**（`providerRetryPolicy` 固定为 0）——重发 prompt 会在 agent 侧重复执行。
- **模型**：codex 的 `model/list` 与 ACP 的 scratch-session `configOptions` 分别喂给 DSH 模型选择器（5 分钟缓存）；每轮的 `model` / `effort` 覆盖会同步到 agent 侧（ACP 半按模型探测推理等级选项）；上下文窗口从 token 用量更新中学到并持久化。
- **设置热拓扑**：`installSettingsSection` 驱动路由集合变化，经 `registerAdapter(routes).replace()` 与 `registerConfigurableProviders(...).replace()` 热替换（带重入保护）；移除路由即回收其进程。设置页读取 `/plugins/dsh-agent-adapter/state.json`（由 ACP 半提供，折叠 codex 半的 contribution），开关经普通 settings mutation 通道写入。
- **client 半**：esbuild 打出的 CJS bundle，包进 `window.__ModuleLoader__.load({ id: 'dsh-agent-adapter' })`，React 外置；按 package.json 的 `dsh.client` 块以 `./client` 导出提供。

codex 半特有：一个 thread 只允许一个活跃写入方，thread resume 假定上一个 app-server 进程已退出（harness 重启场景天然满足）。旧 thread 若锚定在错误目录，删除 `$DSH_HOME/llm-codex/sessions.json` 中对应条目即可重新锚定。
