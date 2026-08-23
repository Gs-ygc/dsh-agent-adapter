# dsh-acp-provider 可行性分析

> 目标：在 DSH（DeepSeek Harness）中实现 ACP（Agent Client Protocol）client，将 ACP 服务（如 opencode）注册为 LLM provider，使创建会话时可以选择 `opencode` 作为 provider、opencode 内的 model 作为会话 model，事实上让 opencode 担任主对话 agent。
>
> 结论先行：**可行，且集成 seam 干净**。DSH 的 `ctx.llm` adapter 注册机制正是为此设计；opencode 1.18.18 的 ACP 实现经实测覆盖了全部必需能力。主要工作量在「无状态 LLM 调用语义 ↔ 有状态 agent 会话语义」的映射层，以及若干双 agent 冲突点的规避设计。

## 1. 集成点：DSH 的 LLM adapter seam

DSH host 平面的 `llm` 服务（`@deepseek-ai/dsh-llm`，`LlmRuntime`）是 provider 注册表 + 流式调用 API：

- 插件通过 `ctx.llm.registerAdapter(['route'], adapter)` 注册 provider 路由；`adapter` 实现抽象类 `LlmAdapter`：
  - `providerInfo(provider)` / `providerRetryPolicy(provider)`
  - `listModels(provider)` → 模型目录（供选择器展示，advisory）
  - `resolveModel(provider, model)` → context window、默认 maxTokens、reasoning efforts
  - `stream(options: GenerateOptions)` → `AsyncIterable<StreamChunk>`（唯一必需方法）
- 注册/注销触发 `llm/adapters-updated` 事件；Web 的模型选择器与设置页（`dsh-client-ui-model-selection`、`dsh-client-ui-settings-models`）监听该事件自动刷新——**adapter 注册后无需任何 UI 工作即可在新建会话时选择**。
- `registerConfigurableProviders()` 让 settings 文档（`$DSH_HOME/settings.yaml` 的 `llm-acp:` 节）声明可配置 provider，Web Models 页可编辑，热生效（`llm-pi-ai` 即此模式：bundle 挂载为 dormant，settings 提供 profile 后路由才上线）。
- 请求载体 `GenerateOptions`：`provider/model/messages/system/tools/reasoningEffort/purpose('compaction'|'session-title')/signal/sessionId`。
- 响应载体 `StreamChunk`：`block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish(reason: stop|tool-calls|max-tokens|aborted|error)`。

挂载位置：**host composition**（profile 的 `cordis.patch.yml` 中 insert 一行），不是 agent preset——模型路由属 host 平面，跨会话共享。

## 2. ACP / opencode 实测结果（本机探针验证）

对 `opencode acp`（v1.18.18，stdio、newline-delimited JSON-RPC 2.0）做了三个探针实测：

| 能力 | 结果 |
|---|---|
| `initialize` | ✅ protocolVersion 1；`loadSession: true`；`promptCapabilities: { image, embeddedContext }`；authMethods 提供 `opencode-login`（用 opencode 自身已登录的凭据，client 无需管 key） |
| `session/new` | ✅ 返回 `sessionId` + `configOptions`（category=`model` 的 select 列出 13 个可用模型，如 `kimi-for-coding/k3`、`opencode/big-pickle`；category=`mode` 列出 build/plan） |
| 模型切换 | ✅ `session/set_config_option {configId:'model', value}`；非法模型返回干净的 JSON-RPC `-32602` 错误 |
| `session/prompt` | ✅ 流式 `session/update` 通知：`agent_thought_chunk`、`agent_message_chunk`、`tool_call`、`tool_call_update`、`available_commands_update`、`usage_update`；result 带 `stopReason` + `usage`（input/output/thought/cachedRead tokens） |
| 多轮 | ✅ 第二轮只发增量 user message，opencode 保有会话状态（正确回答"hello"） |
| `session/load` | ✅ 可按 `sessionId` + `cwd` 恢复会话（含已选模型）→ 进程重启后可续接 |
| 取消 | ✅ 但 **`session/cancel` 必须以 notification（无 id）形式发送**；以 request 形式发送 opencode 报 `Method not found`。notification 形式下 prompt 在 2s 内以 `stopReason:'cancelled'` 返回 |
| 权限 | 未声明 client 端 `fs`/`terminal` 能力时，opencode 用自己的工具和自身权限体系执行文件写入，**不向 client 发 `session/request_permission`**（简单用例下） |

协议参考：[agentclientprotocol/typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk)（官方 SDK，`@agentclientprotocol/sdk`）；也可自实现 stdio JSON-RPC（探针证明 ~百行即可覆盖主流程）。

## 3. 语义映射设计

### 3.1 正向：GenerateOptions → ACP

- `options.sessionId` → ACP `sessionId`：adapter 维护 **DSH session ↔ ACP session 映射表**（持久化到 JSON，含 acpSessionId、cwd、当前 modelId、已发送消息高水位）。
- DSH loop 每次调用携带**全量历史**，ACP 会话是**有状态**的 → adapter 做**增量 diff**：只把高水位之后的 user 消息作为 `session/prompt` 的 prompt blocks 发出。由于 adapter 永不返回 tool-calls（见 3.2），历史只由 user/assistant 文本轮次追加，diff 是安全的。
- 进程重启 / 首次见到某 DSH session：先 `session/load`（opencode 已验证支持）恢复，失败则 `session/new` 并回放全部 user 消息（降级路径）。
- `options.system`、`options.tools`、`temperature` 等：**忽略**——opencode 是完整的 agent，有自己的 system prompt 和工具体系；这正是"让 opencode 当主 agent"的语义。
- `options.model` 变化 → `session/set_config_option(configId:'model')`。
- `options.signal` abort → `session/cancel` **notification**（实测有效）。
- 图片（`ImageBlock`）→ ACP image content block（base64），opencode 声明了 `image: true`。

### 3.2 反向：session/update → StreamChunk

| ACP | StreamChunk |
|---|---|
| `agent_message_chunk` (text) | `text-delta`（block-start/end 包裹） |
| `agent_thought_chunk` | `reasoning-delta` |
| `tool_call` / `tool_call_update` / `plan` | **展示性映射**为 text/reasoning 块（如 `⚙ write src/a.ts`）。⚠️ 绝不映射为 `tool-call` 块——那会触发 DSH loop 用 DSH 工具重复执行 opencode 已执行过的操作 |
| `usage_update` + result.usage | `usage` chunk（字段可直接对上，含 cachedRead） |
| `stopReason: end_turn` | `finish: stop` |
| `stopReason: cancelled` | `finish: aborted` |
| `stopReason: max_tokens` | `finish: max-tokens` |
| JSON-RPC error / 进程崩溃 | `finish: error` + `LlmFailure` |

finish reason **永远不返回 `tool-calls`**，这是双 agent 语义不冲突的关键不变量。

### 3.3 必须本地短路的辅助调用

`GenerateOptions.purpose` 为 `'compaction'` 或 `'session-title'` 的请求**绝不能转发给 opencode**（会作为普通 user 消息污染会话、且得不到预期输出）：

- `dsh-session-title-llm` 未配置 provider/model 时使用会话自身路由 → 会打到本 adapter。对策：adapter 对 `purpose==='session-title'` 在本地从首条 user 消息截断合成标题文本（不触网）；或在 composition 里给 `session-title` 行配置显式的 LLM 路由。
- `dsh-compaction-basic` 默认用 agent 自身 provider/model 做摘要（可用 `summarizationProvider/summarizationModel` 配置覆盖指向真 LLM 路由）。对策：adapter 对 `purpose==='compaction'` 返回本地合成的占位摘要或直接报错让 compaction 回退。**更根本的做法**：`resolveModel` 上报足够大的 `contextWindow`（真实上下文由 opencode 自己管理，它内部有自己的 compaction），让 DSH 侧 token-meter 几乎不触发自动压缩；DSH 日志增长仅为展示用途。

### 3.4 权限边界（v1 简化）

v1 不声明 client 端 `fs`/`terminal` 能力：opencode 用自身工具体系和权限配置执行（实测如此），DSH 的 sandbox/approval 栈不参与 opencode 的文件操作——这一点要在文档中对用户讲明（opencode 进程的权限由 opencode 自己的配置决定）。后续版本可将 `session/request_permission` 桥接到 DSH approval 服务，将 ACP `fs/*` 桥接到 DSH fs 服务，获得统一审批体验。

## 4. 包与部署形态

新建仓库包（本仓库）：

```
dsh-acp-provider/
  package.json            # name 如 dsh-llm-acp，peerDeps: @deepseek-ai/dsh-llm, cordis
  src/index.ts            # Cordis 插件：export name/inject/Config/apply
  src/adapter.ts          # AcpAdapter extends LlmAdapter
  src/client.ts           # stdio JSON-RPC client（或封装官方 SDK）
  src/session-map.ts      # DSH↔ACP 会话映射与持久化
```

- `inject: ['llm']`；Config schema 仿 `llm-pi-ai`：`{ providers: Dict<{ command, args?, env?, cwd?, name? }> }`，settings 命名空间 `llm-acp`。
- settings 热更 → diff profile → `AdapterRegistrationHandle.replace(routes)` 原子换路由（`llm-pi-ai` 同款模式）。
- 子进程拓扑：推荐**每个 provider profile 一个常驻 `opencode acp` 进程**，所有 DSH 会话在其上开 ACP session（实测单进程多 session 正常）；带健康检查与崩溃自动重启，重启后对所有受影响会话走 `session/load`。
- 部署：在 profile 的 `cordis.patch.yml` insert 一行 `- id: llm-acp / name: '<pkg>'`（模型路由属 host 平面）；settings.yaml 加 `llm-acp: { providers: { opencode: { command: opencode, args: [acp] } } }`。
- ⚠️ 沙箱注意：实测在 DSH 的 `workspace-write` 文件沙箱下，spawn 的 opencode 子进程连自己的日志目录都写不了而启动失败。host 侧插件 spawn 子进程需要确认 dsh 的子进程插件/环境不受文件沙箱约束（host 进程本身通常不在 fs 沙箱内，但需在实现期验证）。

## 5. 风险与开放问题

| 风险 | 等级 | 缓解 |
|---|---|---|
| 历史 diff 在边界情况错乱（compaction 改写历史、fork、regenerate） | 中 | 高水位只认追加；发现历史被改写（前缀不匹配）时 fallback：`session/new` + 全量回放 user 轮次 |
| compaction/session-title 误入 opencode 污染会话 | 中 | adapter 按 `purpose` 本地短路（3.3） |
| opencode 无 request-level cancel，仅 notification | 低 | 已验证 notification 形式有效；adapter 内部以 notification 发送 |
| 权限双体系让用户困惑（DSH approval 不拦 opencode 的写文件） | 中 | 文档明示；v2 桥接 approval/fs |
| 长会话 DSH 日志无限增长（展示用历史不压缩） | 低 | 大 contextWindow 上报 + 可选 DSH 侧展示层 pruning |
| opencode ACP 行为版本差异（configOptions 是较新 schema） | 低 | initialize 时按 protocolVersion/agentInfo 做能力协商与降级 |
| `llm/stream` waterfall 中间件（llm-retry 等）对长连接 prompt 的重试语义 | 低 | providerRetryPolicy 返回保守策略（不重试 prompt 调用） |

## 6. 工作量估算

- ACP stdio client + 会话映射 + adapter 主体：约 800–1200 行 TypeScript（探针已趟平协议细节）。
- 设置 schema / 热更 / configurable providers 接入：约 200 行（可照抄 llm-pi-ai 模式）。
- 联调（Web UI 选模型、多轮、取消、重启恢复、compaction/title 短路）：1–2 天。
- 总计：**约 2–4 天**得到可用 v1。

## 7. 「这跟 agent loop 完全不一样」——对，且不需要替换 loop

本插件的行为确实与任何普通 LLM adapter 都不同：真正的 agent 循环（规划、工具执行、多步推进）发生在 opencode 进程内部，DSH 侧看不到也不需要参与。但**这不需要替换或绕过 dsh-agent-loop**，因为 loop 与 adapter 之间的契约本来就只是「流式吐 chunk 直到 finish」。读 `dsh-agent-loop` 源码确认：

- `step()` 的核心循环：组请求 → `llm.stream(request)` → 逐 chunk 记入会话日志并装配 → 看 finish：
  - `stop` 且 assistant 消息中无 `tool-call` 块 → 返回 `{kind:'completed'}`，turn 结束。**loop 从不要求模型必须会调工具**——tool-calls 只是众多 finish 分支之一。
  - `error`/`aborted` → 走 `agent/request-error` waterfall（`llm-retry` 挂在这里）；ACP 路由配 `providerRetryPolicy` 返回空 `retryableCodes` 即可禁用重试，避免失败后重发导致 opencode 侧重复执行同一 prompt。
  - 流式中途 abort → loop 把已流出的块提交为 `interrupted: true` 的 assistant 消息；同时 adapter 侧的 `options.signal` 触发 `session/cancel` notification（实测 2s 内以 `cancelled` 返回）。**中断体验两端都完整**。
- **单次 stream 无超时**：`dsh-llm`/`dsh-agent-loop` 中没有任何 per-call 时长上限（`dsh-timeout` 只用于 retry 退避），opencode 一轮跑多久都行。

所以 ACP adapter 下 loop 自然「退化」为 relay：一条 user 消息进 → 一次 `stream()`（内部是 opencode 的一整个 agent 回合）→ 一条 assistant 消息出。loop 提供的持久化、流式渲染、中断、重试、标题、token 统计全部照常工作。

**代价（也是目标本身）**：该会话中 DSH 的 tools / persona / skills / sandbox / approval 全部失效（adapter 忽略 `options.system` 与 `options.tools`，loop 永远等不到 tool-call）；opencode 使用自己的工具与权限体系。DSH 剩下的是会话外壳：消息流 UI、历史持久化、中断、token 计量、多会话管理与 provider 切换。

## 8. 备选方案对比

- **subagent backend**（仿 `subagent-codex`/`subagent-claude-code` 行）：opencode 只能作为被派发的子 agent，无法成为主对话 agent，不满足目标。
- **`llm/stream` waterfall 中间件**：能劫持调用但拿不到 provider/model 注册与 UI 选择能力，不是正路。
- **LlmAdapter（本方案）**：唯一同时满足"provider 出现在会话创建的选择器 + model 列表来自 opencode + 全量主对话流量"的 seam。✅
