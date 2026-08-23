# dsh-agent-adapter

**English** | [中文](README.zh.md)

External-agent adapter for the [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH) LLM seam — a host-plane plugin that registers external agents as DSH LLM provider routes:

- **codex half** (`agent-adapter.codex`): runs [codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server) (newline-delimited JSON-RPC over stdio) as a DSH provider — **codex itself is the session's conversation partner**.
- **ACP half** (`agent-adapter.acp`): runs [ACP (Agent Client Protocol)](https://agentclientprotocol.com) agents — OpenCode (`opencode acp`), Kimi Code CLI (`kimi acp`), Pi (`pi-acp`) — as DSH providers.

The external agent works with its **own tools, sandbox, and permission system**. DSH still provides the streaming message UI (including reasoning and tool-call cards), session persistence and history replay, interrupt, titles, token statistics, and multi-session management.

Both halves share a single settings namespace, `agent-adapter` (codex slice at `agent-adapter.codex`, ACP slice at `agent-adapter.acp`). Session state is persisted in `$DSH_HOME/llm-codex/sessions.json` / `$DSH_HOME/llm-acp/sessions.json`.

> Design analysis for the ACP half (incl. opencode 1.18 probe results): [docs/feasibility.md](docs/feasibility.md).

## Installation

This is a **host-plane** plugin (model routes are shared across sessions); it mounts into a profile's patch layer.

### Via `dsh plugin` (normal path)

```bash
# 1. Build this package
npm install && npm run build

# 2. Install into the profile (web profile shown)
dsh plugin --profile web add -w file:/path/to/dsh-agent-adapter
```

Then mount it in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    # ...existing entries...
    - id: agent-adapter
      name: 'dsh-agent-adapter'
```

**Restart the harness.** `file:` dependencies are copied into the profile by pnpm, so after rebuilding the package later, refresh the installed copy with `dsh plugin --profile web install --force`.

### From source / development

```bash
git clone <this repo> && cd dsh-agent-adapter
npm install
npm run build              # tsc → lib/ + esbuild bundles the client settings page
npm run test:unit          # no external binaries needed
npm run test:integration   # needs real `codex` and `opencode` on PATH
```

Installing from source is the same `file:` install above, pointing at your clone.

### Configuration (optional)

**No configuration is required.** Agents detected on PATH (codex, opencode, kimi, pi-acp) are enabled by default and appear in the model picker automatically. Add settings only to override defaults or declare agents outside the built-in table — all keys hot-swap and are editable on the Web Models page:

```yaml
agent-adapter:
  codex:
    providers:
      codex:
        command: codex
        args: ['app-server', '--stdio']
        # sandbox / approvalPolicy: optional operator overrides (see below)
    # agents:                     # optional explicit switch for the known agent
    #   codex: { enabled: true }
  acp:
    providers:
      opencode:
        displayName: OpenCode
        command: opencode
        args: [acp]
        permissionPolicy: auto    # auto/allow/deny, see below
    # agents:                     # optional explicit switches for known agents
    #   kimi: { enabled: false }
```

**Known-agent auto-scan**: the plugin ships a built-in table covering both halves — codex (`codex app-server --stdio`) and the ACP agents (`opencode acp`, `kimi acp`, `pi-acp`). Agents detected on PATH are **enabled by default**, no `providers` entry required; only enabled agents become provider routes. The **「Agent 适配 / Agent Adapter」** settings page lists every agent with its detection status and version, ordered installed-first with codex leading, and toggles write `agent-adapter.codex.agents.codex.enabled` / `agent-adapter.acp.agents.<id>.enabled` with immediate effect. Custom `providers` entries are always enabled; an entry with the same id as a known agent acts as a command override but stays gated by its switch. codex authentication is codex's own (`codex login` / ChatGPT account) — this plugin never touches API keys.

### Uninstall

```bash
dsh plugin --profile web remove dsh-agent-adapter
```

Also remove the `agent-adapter` entry from `cordis.patch.yml`. Optionally delete the `agent-adapter:` settings section and the state files `$DSH_HOME/llm-{codex,acp}/sessions.json` (deleting a codex store entry re-anchors that session to a fresh thread).

## Permission adaptation

### codex half

codex approval prompts **always bridge into the DSH approval service** — decided in the Web UI by the session's own approval policy and answerer; a DSH stop withdraws a pending prompt. The bridge is fail-closed: no live session or answerer means decline. user-input and MCP elicitation prompts are always declined (no interactive user on this side).

The execution sandbox follows the DSH session's permission mode, re-evaluated every turn:

| DSH permission mode | codex sandbox | approval_policy | approvals_reviewer |
|---|---|---|---|
| read-only | `readOnly` (no network) | `on-request` | `user` (answered by the DSH user) |
| workspace-write | `workspaceWrite` (writable root = session workspace, network on) | `on-request` | `auto_review` |
| danger-full-access | `dangerFullAccess` | `on-request` | `auto_review` |

Profile `sandbox` / `approvalPolicy` are explicit operator overrides. Set `approvalPolicy: never` for unattended mode (codex decides everything itself, bypassing the bridge).

| Field | Default | Notes |
|---|---|---|
| `command` / `args` | — (required) / `['app-server', '--stdio']` | codex executable and arguments |
| `cwd` | harness process cwd | app-server process cwd; new threads are created in the DSH session's own workspace (header cwd) |
| `env` | inherit harness env | extra environment variables |
| `sandbox` / `approvalPolicy` | derived from the session | operator overrides for the table above |
| `defaultContextWindow` | 272000 | reported until codex discloses the real value |
| `defaultMaxTokens` | 32768 | output cap surfaced through `resolveModel` |

### ACP half

`permissionPolicy: auto | allow | deny` answers `session/request_permission`: `auto` follows the session's own knobs (danger-full-access → `allow_always`, approval `never` → deny, otherwise an approval card inheriting the turn's abort signal); `allow` / `deny` are fixed overrides. Interactive approvals only ever choose `allow_once`. The client does not advertise `fs` / `terminal` capabilities — the agent operates files with its own tool system.

| Field | Default | Notes |
|---|---|---|
| `command` / `args` | — (required) | ACP agent launch command, e.g. `opencode acp` |
| `cwd` | harness process cwd | agent **process** cwd; each ACP session roots in the DSH session's own workspace |
| `env` | inherit harness env | extra environment variables |
| `permissionPolicy` | `auto` | see above |
| `defaultContextWindow` | 200000 | reported until `usage_update` discloses the real value (drives token metering and compaction thresholds) |
| `defaultMaxTokens` | 32768 | default output cap surfaced through `resolveModel` |

### The boundary (read this)

In sessions using these providers, **DSH tools / persona / skills / sandbox / approval do NOT apply to the agent's own operations** — the adapter ignores the system prompt and tools; the agent's own configuration governs its file writes. That is precisely the point of this plugin. The DSH-side history is a display log; the real context lives inside the agent.

## Implementation principles

Between the DSH agent loop and the model sits a single `LlmAdapter` contract (stream chunks until a finish). Both adapters perform a semantic inversion: the DSH loop is stateless (every call carries full history) while the external agent is stateful (it owns the session).

```
DSH agent loop ──stream()──▶ CodexAdapter ──turn/start──▶ codex app-server ──▶ codex agent
                 ◀──StreamChunk──   ◀──item/*, turn/* notifications──

DSH agent loop ──stream()──▶ AcpAdapter ──session/prompt──▶ ACP agent process ──▶ agent
                 ◀──StreamChunk──   ◀──session/update notifications──
```

- **Incremental forwarding**: each adapter maintains a DSH-session ↔ external-session map (persisted under `$DSH_HOME/llm-{codex,acp}/sessions.json`) and sends only **new `source.kind === 'user'` turns**, using append-only fingerprint watermarking (longest tail/head overlap; a history it cannot align — e.g. after compaction — degrades to the latest turn only). Backlog turns run silently; only the last one streams. `purpose: compaction | session-title` calls are answered locally and never touch the agent; after a process restart, sessions resume via `thread/resume` / `session/load`.
- **One long-lived process per route** (lazy spawn, respawn on exit), speaking newline-delimited JSON-RPC — the codex app-server protocol (no `jsonrpc` field) or ACP JSON-RPC 2.0. Sessions map to codex threads (`thread/start` / `thread/resume`) or ACP sessions (`session/new` / `session/load`); the mapping plus watermarks are persisted atomically (tmp + rename).
- **Tool mirroring (echo display tools)**: tool calls, plans, and permissions all happen inside the agent process. codex `commandExecution` / `fileChange` / `mcpToolCall` / `webSearch` items and ACP `tool_call_update`s are mirrored as DSH `tool-call` blocks bound to display-only echo tools (`codex_command` / `codex_file_change` / `codex_mcp_tool` / `codex_web_search`, `acp_command` / `acp_file_change` / `acp_tool`) registered on the session's own agent scope. Their `execute()` merely awaits the outcome the adapter recorded — never any real work — while `presentCall` / `presentResult` render terminal cards (command + output + exit code) and edit cards (paths + diff) just like native DSH bash/edit. One external turn can therefore span several DSH steps, with a TurnPump assembling StreamChunks across `stream()` calls; when nothing trails the last echo, it settles `final` and calls `concludeTurn()` to avoid a trailing empty step. One-shot calls without a DSH session identity fall back to text display blocks.
- **Interrupt**: DSH stop → `turn/interrupt` (codex) / `session/cancel` notification (ACP); the turn settles `aborted` and partial output is kept. **Zero retries** (`providerRetryPolicy` fixed at 0) — a re-sent prompt would execute twice on the agent side.
- **Models**: codex `model/list` and the ACP scratch-session `configOptions` feed the DSH model picker (5-minute cache); per-turn `model` / `effort` overrides sync to the agent (the ACP half probes reasoning-effort options per model); the context window is learned from token-usage updates and persisted.
- **Settings-hot topology**: `installSettingsSection` drives route-set changes through `registerAdapter(routes).replace()` + `registerConfigurableProviders(...).replace()` with re-entrancy guards; removed routes dispose their processes. The settings page reads `/plugins/dsh-agent-adapter/state.json` (served by the ACP half, folding in the codex half's contribution) and writes switches through the ordinary settings mutation channel.
- **Client half**: an esbuild CJS bundle wrapped in `window.__ModuleLoader__.load({ id: 'dsh-agent-adapter' })` with React external, served as the package's `./client` export per the `dsh.client` manifest block.

codex-specific: a thread allows only one active writer; thread resume assumes the previous app-server process has exited (naturally true across harness restarts). If an old thread is anchored in the wrong directory, delete its entry in `$DSH_HOME/llm-codex/sessions.json` to re-anchor.
