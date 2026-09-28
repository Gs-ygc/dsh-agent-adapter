# Gs-ygc fork of dsh-agent-adapter

基线: upstream `a6b9866`（0.1.0 release）+ `stable` 分支 overlay（直接提交构建产物 lib/，安装即用）。

## Overlay 内容（dev 补丁）
- codex app-server: dynamicToolCall 镜像、thread/start dynamicTools、pushUsage 口径（uncached=total−cacheRead−cacheWrite）
- item/tool/call 回调应答（answerDynamicTool）
- onItemStarted toolNameFor 修复
- stream 韧性（request_max_retries / stream_max_retries / stream_idle_timeout_ms 透传）

## 2026-09-28 增补
- `CodexAdapter.deleteEngineSession(provider, dshSessionId)`：调 codex `thread/delete` 删引擎线程 + 清映射（在飞 turn 保护，失败仍清映射）
- `storedSessionIds(provider)` / `CodexSessionStore.deleteSession`：供宿主对账扫描
- 消费方：@local/codex-appserver shim 启动时对账——DSH 会话目录不存在的映射自动清引擎侧

## 跟上游合并
上游发好东西时：fetch upstream，从对应提交开 stable-<ver> 分支，重放本 overlay 到新 lib（或按上游 src 对齐），dev profile 换分支验证。
