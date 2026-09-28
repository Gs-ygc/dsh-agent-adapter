/**
 * CodexAdapter: serves DSH LLM routes backed by `codex app-server` processes.
 *
 * The semantic inversion at the heart of this adapter: the harness loop sends
 * a stateless full-history completion request, while codex owns a stateful
 * thread and runs the whole agent turn itself (planning, commands, file
 * edits). The adapter bridges the two by delivering only NEW human turns
 * (append-only watermark over `source.kind === 'user'` messages) and
 * translating turn/item notifications back into the harness stream
 * vocabulary. codex's tool items are mirrored as `tool-call` blocks naming
 * display-only echo tools (see tools.ts) — they replay codex's recorded
 * outcome and never dispatch work themselves.
 *
 * @module dsh-agent-adapter/codex/adapter
 */
import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId, } from '@deepseek-ai/dsh-llm';
import { CodexProcess, CodexRpcError, CodexTransportError, } from './client.js';
import { CodexToolOutcomes, codexDisplayTools } from './tools.js';
/** No automatic retry: a re-sent prompt would duplicate the turn codex-side. */
const NO_RETRY = {
    mode: 'normal',
    maxRetries: 0,
    retryableCodes: [],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
};
const MODEL_CACHE_TTL_MS = 5 * 60_000;
/** Command output shown on completion is tail-truncated to this many chars. */
const OUTPUT_TAIL_CHARS = 1500;
/** Extract human turns; tool results and plugin context never reach codex. */
function extractUserTurns(messages) {
    const turns = [];
    for (const message of messages) {
        if (message.role !== 'user' || message.source.kind !== 'user')
            continue;
        let text = '';
        const images = [];
        for (const block of message.content) {
            if (block.type === 'text')
                text += (text ? '\n' : '') + block.text;
            else if (block.type === 'image')
                images.push(block.attachment);
        }
        turns.push({
            text,
            images,
            fingerprint: images.length === 0 ? text : `${text}\0img:${images.map((i) => i.attachmentId).join(',')}`,
        });
    }
    return turns;
}
/**
 * Longest overlap where the tail of `sent` equals the head of `current`.
 * Covers both the append-only case (sent is a prefix of current) and
 * post-compaction history (current starts mid-way through sent).
 */
function overlapLength(sent, current) {
    const max = Math.min(sent.length, current.length);
    for (let k = max; k > 0; k--) {
        let match = true;
        for (let i = 0; i < k; i++) {
            if (sent[sent.length - k + i] !== current[i].fingerprint) {
                match = false;
                break;
            }
        }
        if (match)
            return k;
    }
    return 0;
}
function normalizeMode(mode) {
    return mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access' ? mode : undefined;
}
/**
 * codex execution settings derived from the DSH session's permission mode:
 * the sandbox mirrors the mode 1:1, approval prompts always route on-request,
 * and the reviewer is the DSH user (through the approval bridge) under
 * read-only, codex's automatic reviewer otherwise.
 */
function codexSandboxPolicy(mode, cwd) {
    switch (mode) {
        case 'read-only':
            return { type: 'readOnly', networkAccess: false };
        case 'workspace-write':
            return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
        case 'danger-full-access':
            return { type: 'dangerFullAccess' };
    }
}
/**
 * Push-based chunk assembler: codex thread notifications in, StreamChunks out.
 * One codex turn maps to one or more DSH steps: text/reasoning deltas stream
 * into open blocks, and when a tool item (commandExecution / fileChange /
 * mcpToolCall / webSearch) starts, the pump emits a complete `tool-call` block
 * and flushes the step with a `tool-calls` finish — the agent loop then
 * "executes" the display-only echo tool, whose result the adapter publishes
 * once codex settles the item (non-final) or completes the turn (final, which
 * concludes the DSH turn without a trailing empty step). The pump object
 * survives across the per-step stream() calls of one codex turn.
 */
class TurnPump {
    learnContextWindow;
    logger;
    outcomes;
    useToolBlocks;
    onTurnCompleted;
    queue = [];
    waiter;
    /** True once the turn's terminal finish chunk has been pushed. */
    done = false;
    blockIndex = -1;
    openType;
    openText = '';
    /** itemId owning the currently open text/reasoning block. */
    openItemId;
    /** Latest token usage snapshot observed for this turn. */
    usage;
    /** Deferred outcome when turn/completed raced ahead of turn/start. */
    pendingOutcome;
    /** Tool items begun this turn whose echo is still awaiting an outcome. */
    pendingItems = new Set();
    /** Settled tool item data, resolved at the next item start or turn end. */
    settledItems = new Map();
    turnId;
    /** Set when the turn's turn/completed notification has been processed. */
    turnOutcome;
    constructor(learnContextWindow, logger, outcomes, useToolBlocks, 
    /** Invoked synchronously when turn/completed is processed (any status). */
    onTurnCompleted) {
        this.learnContextWindow = learnContextWindow;
        this.logger = logger;
        this.outcomes = outcomes;
        this.useToolBlocks = useToolBlocks;
        this.onTurnCompleted = onTurnCompleted;
    }
    /** The chunks of one DSH step: yields until a finish chunk, then ends. */
    async *step() {
        while (true) {
            const chunk = await this.nextChunk();
            if (chunk === undefined)
                return;
            yield chunk;
            if (chunk.type === 'finish')
                return;
        }
    }
    nextChunk() {
        const chunk = this.queue.shift();
        if (chunk)
            return Promise.resolve(chunk);
        if (this.done)
            return Promise.resolve(undefined);
        return new Promise((resolve) => {
            this.waiter = () => resolve(this.queue.shift());
        });
    }
    push(chunk) {
        this.queue.push(chunk);
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.();
    }
    openBlock(type, itemId) {
        if (this.openType === type && this.openItemId === itemId)
            return;
        this.closeBlock();
        this.blockIndex += 1;
        this.openType = type;
        this.openItemId = itemId;
        this.openText = '';
        this.push({ type: 'block-start', index: this.blockIndex, blockType: type });
    }
    closeBlock() {
        if (this.openType === undefined)
            return;
        const type = this.openType;
        const text = this.openText;
        this.openType = undefined;
        this.openItemId = undefined;
        this.openText = '';
        this.push({ type: 'block-end', index: this.blockIndex, block: { type, text } });
    }
    /** A self-contained display-only text block. */
    displayBlock(text) {
        this.closeBlock();
        this.blockIndex += 1;
        this.push({ type: 'block-start', index: this.blockIndex, blockType: 'text' });
        this.push({ type: 'text-delta', index: this.blockIndex, text });
        this.push({ type: 'block-end', index: this.blockIndex, block: { type: 'text', text } });
    }
    /** Latest usage as a chunk; emitted at every step/turn finish. */
    pushUsage() {
        const last = this.usage?.last;
        if (!last || (!last.inputTokens && !last.outputTokens))
            return;
        // CONVENTION: codex reports `inputTokens` as the TOTAL prompt
        // (measured: totalTokens = inputTokens + outputTokens, with
        // cachedInputTokens a SUBSET of inputTokens), while DSH's usage contract
        // is DISJOINT — its `inputTokens` means UNCACHED input, and the cache-hit
        // strip divides cacheRead by (uncached + cacheRead + cacheWrite). Passing
        // codex's total straight through therefore double-counts the cached
        // tokens and pins the displayed hit rate near 50%. Normalize to the
        // disjoint contract the way the CLI engines' `toUsage` does.
        const rawInput = Number(last.inputTokens ?? 0);
        const cacheRead = Number(last.cachedInputTokens ?? 0);
        const cacheWrite = Number(last.cacheWriteInputTokens ?? 0);
        const tokenUsage = {
            inputTokens: Math.max(0, rawInput - cacheRead - cacheWrite),
            outputTokens: last.outputTokens,
            ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
            ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
            ...(last.reasoningOutputTokens ? { reasoningTokens: last.reasoningOutputTokens } : {}),
        };
        this.push({ type: 'usage', usage: tokenUsage });
    }
    /** End the current DSH step with a `tool-calls` finish. */
    flushStep() {
        this.closeBlock();
        this.pushUsage();
        this.push({ type: 'finish', reason: { kind: 'tool-calls' } });
    }
    /** True when this notification belongs to the streamed turn. */
    forThisTurn(params) {
        if (!this.turnId)
            return true;
        const turnId = params.turnId;
        return typeof turnId !== 'string' || turnId === this.turnId;
    }
    onNotification(notification) {
        const { method, params } = notification;
        if (/item\/(started|completed)/.test(method))
        if (method === 'transport/lost') {
            this.settle({ status: 'failed', errorMessage: `codex transport lost: ${String(params.message ?? 'process exited')}` });
            return;
        }
        if (!this.forThisTurn(params))
            return;
        switch (method) {
            case 'item/agentMessage/delta': {
                const delta = typeof params.delta === 'string' ? params.delta : '';
                if (!delta)
                    break;
                this.openBlock('text', typeof params.itemId === 'string' ? params.itemId : undefined);
                this.openText += delta;
                this.push({ type: 'text-delta', index: this.blockIndex, text: delta });
                break;
            }
            case 'item/reasoning/summaryTextDelta':
            case 'item/reasoning/textDelta': {
                const delta = typeof params.delta === 'string' ? params.delta : '';
                if (!delta)
                    break;
                this.openBlock('reasoning', typeof params.itemId === 'string' ? params.itemId : undefined);
                this.openText += delta;
                this.push({ type: 'reasoning-delta', index: this.blockIndex, text: delta });
                break;
            }
            case 'item/started': {
                const item = params.item;
                if (!item)
                    break;
                this.onItemStarted(item);
                break;
            }
            case 'item/completed': {
                const item = params.item;
                if (!item)
                    break;
                this.onItemCompleted(item);
                break;
            }
            case 'turn/plan/updated': {
                const plan = Array.isArray(params.plan) ? params.plan : [];
                if (plan.length > 0) {
                    const lines = plan.map((e) => `- [${e.status ?? 'pending'}] ${e.step ?? ''}`).join('\n');
                    this.displayBlock(`\n\n📋 ${lines}\n\n`);
                }
                break;
            }
            case 'thread/tokenUsage/updated': {
                const usage = params.tokenUsage;
                if (!usage)
                    break;
                this.usage = usage;
                if (usage.modelContextWindow && usage.modelContextWindow > 0) {
                    this.learnContextWindow(usage.modelContextWindow);
                }
                break;
            }
            case 'error': {
                const err = params.error;
                this.logger(`codex: mid-turn error: ${err?.message ?? JSON.stringify(params).slice(0, 300)}`);
                break;
            }
            case 'turn/completed': {
                const turn = params.turn;
                if (!turn)
                    break;
                if (this.turnId && turn.id !== this.turnId)
                    break;
                const outcome = {
                    status: turn.status,
                    ...(turn.error?.message ? { errorMessage: turn.error.message } : {}),
                };
                if (this.turnId)
                    this.settle(outcome);
                else
                    this.pendingOutcome = outcome;
                break;
            }
            default:
                break;
        }
    }
    /** Display-tool name for a codex item type, or undefined for plain items. */
    toolNameFor(type, item) {
        switch (type) {
            case 'commandExecution': return 'codex_command';
            case 'fileChange': return 'codex_file_change';
            case 'mcpToolCall': return 'codex_mcp_tool';
            case 'webSearch': return 'codex_web_search';
            // A tool the CLIENT declared (thread/start `dynamicTools`). Codex
            // names it on the item, and DSH executed it, so mirror it under that
            // exact name — the loop dispatches the echo by this name.
            case 'dynamicToolCall': return typeof item?.tool === 'string' && item.tool !== '' ? item.tool : 'codex_dynamic_tool';
            default: return undefined;
        }
    }
    /** The tool-call arguments mirroring one codex item's input. */
    toolArgsFor(item) {
        switch (item.type) {
            case 'commandExecution':
                return {
                    command: typeof item.command === 'string' ? item.command : 'command',
                    ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
                };
            case 'fileChange':
                return { changes: (item.changes ?? []).map((c) => ({ path: c.path, kind: c.kind, ...(c.diff ? { diff: c.diff } : {}) })) };
            case 'mcpToolCall':
                return {
                    server: item.server ?? '',
                    tool: item.tool ?? '',
                    ...(item.arguments !== undefined ? { arguments: item.arguments } : {}),
                };
            case 'dynamicToolCall':
                return item.arguments !== undefined && item.arguments !== null && typeof item.arguments === 'object'
                    ? item.arguments
                    : { arguments: item.arguments };
            case 'webSearch':
                return { query: item.query ?? '' };
            default:
                return {};
        }
    }
    /** The outcome payload published when one codex item settles. */
    outcomeDataFor(item) {
        const status = item.status ?? 'completed';
        switch (item.type) {
            case 'commandExecution':
                return {
                    status,
                    ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {}),
                    ...(item.exitCode !== undefined && item.exitCode !== null ? { exitCode: item.exitCode } : {}),
                    ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
                };
            case 'mcpToolCall': {
                const error = item.error;
                return {
                    status,
                    ...(item.result !== undefined ? { result: item.result } : {}),
                    ...(error ? { error: typeof error === 'string' ? error : error.message ?? 'error' } : {}),
                };
            }
            case 'dynamicToolCall':
                // The client-declared tool ran on the DSH side; its answer already
                // reached codex through the callback's contentItems. Only the
                // lifecycle status is mirrored here.
                return { status };
            default:
                return { status };
        }
    }
    /** Resolve every settled item's echo; `final` only at turn end. */
    resolveSettled(final) {
        for (const [itemId, data] of [...this.settledItems]) {
            this.settledItems.delete(itemId);
            this.pendingItems.delete(itemId);
            this.outcomes.publish(itemId, { ...data, final });
        }
    }
    onItemStarted(item) {
        // A new item proves the previously settled items were not turn-terminal.
        this.resolveSettled(false);
        const toolName = this.useToolBlocks ? this.toolNameFor(item.type, item) : undefined;
        if (toolName) {
            this.outcomes.begin(item.id);
            this.pendingItems.add(item.id);
            const args = this.toolArgsFor(item);
            const argumentsText = JSON.stringify(args);
            const callId = ToolCallId(item.id);
            this.closeBlock();
            this.blockIndex += 1;
            this.push({ type: 'block-start', index: this.blockIndex, blockType: 'tool-call' });
            this.push({ type: 'tool-call-delta', index: this.blockIndex, id: callId, name: toolName, argumentsDelta: argumentsText });
            this.push({ type: 'block-end', index: this.blockIndex, block: { type: 'tool-call', id: callId, name: toolName, arguments: argumentsText } });
            // Flush the step so the loop "executes" the echo now: the tool card
            // appears in running state while codex is still working on the item.
            this.flushStep();
            return;
        }
        // Legacy text display (no display-tool registration on this session).
        switch (item.type) {
            case 'commandExecution': {
                const command = typeof item.command === 'string' ? item.command : 'command';
                this.displayBlock(`\n\n⚙️ \`${command.split('\n')[0].slice(0, 200)}\`\n\n`);
                break;
            }
            case 'fileChange': {
                const paths = (item.changes ?? []).map((c) => c.path).filter(Boolean).join(', ');
                this.displayBlock(`\n\n📝 file change${paths ? `: ${paths}` : ''}\n\n`);
                break;
            }
            case 'mcpToolCall': {
                this.displayBlock(`\n\n🔧 MCP \`${item.server ?? ''}/${item.tool ?? ''}\`\n\n`);
                break;
            }
            case 'webSearch': {
                this.displayBlock(`\n\n🔍 web search: ${item.query ?? ''}\n\n`);
                break;
            }
            case 'enteredReviewMode': {
                this.displayBlock(`\n\n🔎 review started: ${item.review ?? ''}\n\n`);
                break;
            }
            case 'contextCompaction': {
                this.displayBlock(`\n\n🗜️ codex compacted the conversation history\n\n`);
                break;
            }
            default:
                break;
        }
    }
    onItemCompleted(item) {
        if (this.useToolBlocks && this.pendingItems.has(item.id)) {
            // Resolve at the next boundary, when the `final` flag is known.
            this.settledItems.set(item.id, this.outcomeDataFor(item));
            return;
        }
        switch (item.type) {
            case 'commandExecution': {
                const status = item.status ?? 'completed';
                const exit = typeof item.exitCode === 'number' ? `exit ${item.exitCode}` : status;
                const duration = typeof item.durationMs === 'number' ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : '';
                const icon = status === 'completed' ? '✅' : status === 'declined' ? '🚫' : '❌';
                const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.trim() : '';
                // Tail-biased truncation: the interesting part of command output
                // (errors, results) is at the end.
                const tail = output.length > OUTPUT_TAIL_CHARS ? `…\n${output.slice(-OUTPUT_TAIL_CHARS)}` : output;
                this.displayBlock(`\n\n${icon} \`${exit}\`${duration}${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''}\n\n`);
                break;
            }
            case 'fileChange': {
                if (item.status && item.status !== 'completed') {
                    this.displayBlock(`\n\n📝 file change ${item.status}\n\n`);
                }
                break;
            }
            case 'exitedReviewMode': {
                if (typeof item.review === 'string' && item.review.trim()) {
                    this.displayBlock(`\n\n🔎 review:\n${item.review}\n\n`);
                }
                break;
            }
            default:
                break;
        }
    }
    /** Called once turn/start resolves so late notifications can be filtered. */
    setTurnId(turnId) {
        this.turnId = turnId;
        if (this.pendingOutcome) {
            const outcome = this.pendingOutcome;
            this.pendingOutcome = undefined;
            this.settle(outcome);
        }
    }
    /** Terminal: resolve every echo, close open blocks, emit the finish chunk. */
    settle(outcome) {
        if (this.done)
            return;
        this.turnOutcome = outcome;
        // Echoes conclude the DSH turn only when nothing follows the last tool
        // step: trailing text/reasoning queued since the last flush must still be
        // streamed by one more step, so its echo resolves as non-final.
        const trailing = this.queue.length > 0;
        this.resolveSettled(!trailing);
        for (const itemId of [...this.pendingItems]) {
            this.pendingItems.delete(itemId);
            this.outcomes.publish(itemId, { status: outcome.status === 'completed' ? 'completed' : outcome.status, final: !trailing });
        }
        this.onTurnCompleted(outcome);
        this.closeBlock();
        this.pushUsage();
        switch (outcome.status) {
            case 'interrupted':
                this.push({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'turn interrupted', code: 'INTERRUPTED' } } });
                break;
            case 'failed':
                this.push({ type: 'finish', reason: { kind: 'error', failure: { message: outcome.errorMessage ?? 'codex turn failed', code: 'CODEX_TURN_FAILED' } } });
                break;
            default:
                this.push({ type: 'finish', reason: { kind: 'stop' } });
        }
        this.done = true;
        // Wake a parked consumer so it observes `done` even with an empty queue.
        if (this.queue.length === 0) {
            const waiter = this.waiter;
            this.waiter = undefined;
            waiter?.();
        }
    }
}
export class CodexAdapter extends LlmAdapter {
    deps;
    processes = new Map();
    modelCache = new Map();
    /** Full codex catalog entries (reasoning efforts, modalities) by model id. */
    catalog = new Map();
    learnedContextWindow = new Map();
    /** In-flight sessions keyed by `${route}/${dshKey}` to survive stream calls. */
    liveSessions = new Map();
    /** Abort signal of the turn currently streaming on each codex thread. */
    activeTurnSignals = new Map();
    /** In-flight codex turns keyed by liveKey; one codex turn spans several
     *  DSH steps (several stream() calls) when tool items are mirrored. */
    activeTurns = new Map();
    /** Shared registry the display-only echo tools await their outcomes on. */
    toolOutcomes = new CodexToolOutcomes();
    /** liveKeys whose display tools registered successfully. */
    toolsReady = new Set();
    constructor(deps) {
        super();
        this.deps = deps;
    }
    providerInfo(provider) {
        const profile = this.deps.profiles().get(provider);
        return { id: provider, name: profile?.displayName ?? provider };
    }
    providerRetryPolicy() {
        return NO_RETRY;
    }
    profileFor(provider) {
        const profile = this.deps.profiles().get(provider);
        if (!profile) {
            throw new LlmError(`llm-codex: provider route "${provider}" is not configured; add it under the llm-codex providers settings section`, 'NO_ADAPTER');
        }
        return profile;
    }
    ensureProcess(provider, profile) {
        const existing = this.processes.get(provider);
        if (existing)
            return existing;
        const proc = new CodexProcess({
            command: profile.command,
            args: profile.args,
            cwd: profile.cwd ?? process.cwd(),
            env: profile.env,
            onApproval: async (request) => {
                if (!this.deps.requestApproval)
                    return undefined;
                const session = [...this.liveSessions.values()].find((s) => s.threadId === request.threadId);
                if (!session?.dshKey)
                    return undefined;
                return this.deps.requestApproval({
                    sessionId: session.dshKey,
                    kind: request.kind,
                    command: request.command,
                    reason: request.reason,
                    signal: request.threadId ? this.activeTurnSignals.get(request.threadId) : undefined,
                });
            },
            // Client-declared dynamic tools (thread/start `dynamicTools`): codex
            // calls back `item/tool/call` and the deps handler answers. This is
            // how a codex turn reaches DSH-side capabilities such as subagents.
            // The callback carries codex's threadId; map it back to the DSH
            // session so a handler can act as that session's agent.
            onDynamicToolCall: (request) => {
                const session = [...this.liveSessions.values()].find((s) => s.threadId === request.threadId);
                return this.deps.callDynamicTool?.({
                    ...request,
                    ...(session?.dshKey ? { dshSessionId: session.dshKey } : {}),
                });
            },
            logger: this.deps.logger,
        });
        this.processes.set(provider, proc);
        return proc;
    }
    /** Drop processes and cached state for routes no longer configured. */
    reconcileRoutes() {
        const routes = new Set(this.deps.profiles().keys());
        for (const [route, proc] of this.processes) {
            if (!routes.has(route)) {
                proc.dispose();
                this.processes.delete(route);
                this.modelCache.delete(route);
                this.catalog.delete(route);
                this.learnedContextWindow.delete(route);
                this.deps.store.deleteRoute(route);
            }
        }
    }
    async listModels(provider) {
        const profile = this.deps.profiles().get(provider);
        if (!profile)
            return [];
        const cached = this.modelCache.get(provider);
        if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS)
            return cached.models;
        const proc = this.ensureProcess(provider, profile);
        await proc.ensureStarted();
        const result = await proc.request('model/list', {});
        const entries = (result.data ?? []).filter((m) => !m.hidden);
        const catalog = new Map();
        const models = entries.map((m) => {
            const id = m.model || m.id;
            catalog.set(id, m);
            return {
                provider,
                id,
                name: m.displayName || id,
                ...(m.description ? { description: m.description } : {}),
                ...(m.inputModalities?.length
                    ? { inputModalities: m.inputModalities.filter((x) => x === 'text' || x === 'image') }
                    : {}),
            };
        });
        this.catalog.set(provider, catalog);
        this.modelCache.set(provider, { at: Date.now(), models });
        return models;
    }
    async resolveModel(provider, model) {
        const profile = this.profileFor(provider);
        // Cold start: resolveModel may run before any listModels call; populate
        // the catalog so reasoning efforts are available on first resolve.
        if (!this.catalog.get(provider)?.has(model)) {
            try {
                await this.listModels(provider);
            }
            catch { /* fall through with defaults */ }
        }
        const known = this.modelCache.get(provider)?.models.find((m) => m.id === model);
        const entry = this.catalog.get(provider)?.get(model);
        // Codex advertises effort options per model; preserve the catalog order —
        // it is the provider's intended progression.
        const efforts = entry?.supportedReasoningEfforts ?? [];
        return {
            provider,
            id: model,
            name: known?.name ?? model,
            context: { contextWindow: this.learnedContextWindow.get(provider) ?? profile.defaultContextWindow },
            defaultMaxTokens: profile.defaultMaxTokens,
            ...(efforts.length > 0
                ? {
                    reasoning: {
                        efforts: efforts.map((e) => ({
                            id: ReasoningEffortId(e.reasoningEffort),
                            name: e.reasoningEffort,
                            ...(e.description ? { description: e.description } : {}),
                        })),
                        ...(entry?.defaultReasoningEffort ? { defaultEffort: ReasoningEffortId(entry.defaultReasoningEffort) } : {}),
                    },
                }
                : {}),
        };
    }
    async establishSession(provider, profile, proc, options) {
        const dshKey = options.sessionId;
        const liveKey = `${provider}/${dshKey ?? ''}`;
        if (dshKey) {
            const live = this.liveSessions.get(liveKey);
            if (live)
                return live;
            const stored = this.deps.store.get(provider, dshKey);
            if (stored) {
                try {
                    await proc.request('thread/resume', { threadId: stored.threadId, excludeTurns: true });
                    const revived = { ...stored, sentUserTurns: [...stored.sentUserTurns], dshKey };
                    this.liveSessions.set(liveKey, revived);
                    return revived;
                }
                catch (error) {
                    this.deps.logger(`codex: thread/resume failed for ${stored.threadId}, creating a fresh thread: ${error}`);
                }
            }
        }
        // Explicit profile cwd wins as an operator override; otherwise the codex
        // thread lives in the DSH session's own workspace; the harness process
        // launch directory is only a last-resort fallback.
        const cwd = profile.cwd
            ?? (dshKey ? this.deps.sessionCwd?.(dshKey) : undefined)
            ?? process.cwd();
        const params = { cwd };
        if (options.model)
            params.model = options.model;
        Object.assign(params, this.threadPermissionParams(profile, dshKey));
        // Tools DSH contributes to this codex thread. Declared per thread, so
        // the harness owns the list (not codex's config); codex calls them back
        // as `item/tool/call`. Empty/absent keeps codex's own toolset untouched.
        const dynamicTools = this.deps.dynamicTools?.();
        if (Array.isArray(dynamicTools) && dynamicTools.length > 0)
            params.dynamicTools = dynamicTools;
        // One-shot calls (auxiliary purposes are short-circuited before this, so
        // these are hand-built calls without a DSH session) use in-memory threads.
        if (!dshKey)
            params.ephemeral = true;
        const created = await proc.request('thread/start', params);
        const session = {
            threadId: created.thread.id,
            cwd,
            sentUserTurns: [],
            ...(options.model ? { model: options.model } : {}),
            ...(dshKey ? { dshKey } : {}),
        };
        if (dshKey) {
            this.liveSessions.set(liveKey, session);
            this.persistSession(provider, session);
        }
        return session;
    }
    /**
     * codex execution settings for the DSH session's current permission mode.
     * Profile `sandbox` / `approvalPolicy` settings are explicit operator
     * overrides; without a resolvable mode nothing is sent and codex falls back
     * to its own config.
     */
    permissionBase(profile, dshKey) {
        const sessionMode = normalizeMode(dshKey ? this.deps.sessionPermission?.(dshKey) : undefined);
        const mode = normalizeMode(profile.sandbox) ?? sessionMode;
        return {
            ...(mode ? { mode } : {}),
            ...(profile.approvalPolicy
                ? { approvalPolicy: profile.approvalPolicy }
                : mode
                    ? { approvalPolicy: 'on-request' }
                    : {}),
            ...(sessionMode ? { approvalsReviewer: sessionMode === 'read-only' ? 'user' : 'auto_review' } : {}),
        };
    }
    /** thread/start flavor: sandbox is the plain mode string. */
    threadPermissionParams(profile, dshKey) {
        const base = this.permissionBase(profile, dshKey);
        return {
            ...(base.mode ? { sandbox: base.mode } : {}),
            ...(base.approvalPolicy ? { approvalPolicy: base.approvalPolicy } : {}),
            ...(base.approvalsReviewer ? { approvalsReviewer: base.approvalsReviewer } : {}),
        };
    }
    /** turn/start flavor: sandbox is the structured SandboxPolicy object. */
    turnPermissionParams(profile, session) {
        const base = this.permissionBase(profile, session.dshKey);
        return {
            ...(base.mode ? { sandboxPolicy: codexSandboxPolicy(base.mode, session.cwd) } : {}),
            ...(base.approvalPolicy ? { approvalPolicy: base.approvalPolicy } : {}),
            ...(base.approvalsReviewer ? { approvalsReviewer: base.approvalsReviewer } : {}),
        };
    }
    persistSession(provider, session) {
        if (!session.dshKey)
            return;
        const stored = {
            threadId: session.threadId,
            cwd: session.cwd,
            sentUserTurns: [...session.sentUserTurns],
            ...(session.model ? { model: session.model } : {}),
            ...(this.learnedContextWindow.get(provider) ? { contextWindow: this.learnedContextWindow.get(provider) } : {}),
        };
        this.deps.store.set(provider, session.dshKey, stored);
    }
    /** Locally answered auxiliary calls: never forwarded to codex. */
    async *auxiliary(options) {
        let text;
        if (options.purpose === 'session-title') {
            text = titleFrom(options.messages) ?? 'codex session';
        }
        else {
            text = 'Earlier conversation omitted; codex retains full thread context internally.';
        }
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
    }
    /**
     * Run one turn to completion without streaming (used to rebuild codex-side
     * context for backlog human turns after a history realignment).
     */
    async runTurnSilently(proc, threadId, input) {
        let done;
        const completed = new Promise((resolve) => { done = resolve; });
        let turnId;
        const dispose = proc.onThreadNotification(threadId, (notification) => {
            if (notification.method !== 'turn/completed')
                return;
            const turn = notification.params.turn;
            if (!turn)
                return;
            if (turnId && turn.id !== turnId)
                return;
            done({ status: turn.status, ...(turn.error?.message ? { errorMessage: turn.error.message } : {}) });
        });
        try {
            const started = await proc.request('turn/start', { threadId, input });
            turnId = started.turn.id;
            const outcome = await completed;
            if (outcome.status === 'failed') {
                this.deps.logger(`codex: backlog turn failed on thread ${threadId}: ${outcome.errorMessage ?? 'unknown error'}`);
            }
        }
        finally {
            dispose();
        }
    }
    /** Register the display tools once per session; false forces text display. */
    ensureDisplayTools(liveKey, dshKey) {
        if (!dshKey || !this.deps.registerTools)
            return false;
        if (this.toolsReady.has(liveKey))
            return true;
        try {
            const dyn = this.deps.dynamicTools?.();
            this.deps.registerTools(dshKey, codexDisplayTools(this.toolOutcomes, dyn));
            this.toolsReady.add(liveKey);
            return true;
        }
        catch (error) {
            this.deps.logger(`codex: display tool registration failed, using text display: ${error}`);
            return false;
        }
    }
    /** Send turn/interrupt for an active turn; safe before turn/start resolves. */
    interruptTurn(proc, entry) {
        if (!entry.pump.turnId)
            return;
        proc.request('turn/interrupt', { threadId: entry.threadId, turnId: entry.pump.turnId })
            .catch((error) => this.deps.logger(`codex: turn/interrupt failed: ${error}`));
    }
    /** Detach a finished turn: notification listener, signal mapping, entry. */
    closeActiveTurn(liveKey, entry) {
        if (this.activeTurns.get(liveKey) !== entry)
            return;
        this.activeTurns.delete(liveKey);
        entry.disposeListener();
        this.activeTurnSignals.delete(entry.threadId);
    }
    async *stream(options) {
        if (options.purpose === 'compaction' || options.purpose === 'session-title') {
            yield* this.auxiliary(options);
            return;
        }
        const provider = options.provider;
        const profile = this.profileFor(provider);
        const proc = this.ensureProcess(provider, profile);
        await proc.ensureStarted();
        const liveKey = `${provider}/${options.sessionId ?? ''}`;
        // Continuation step of an in-flight codex turn: the previous step ended
        // with a `tool-calls` finish, the loop executed the echo tools, and now
        // asks for the next step. No new turn is started codex-side.
        const active = this.activeTurns.get(liveKey);
        if (active && !active.pump.turnOutcome) {
            const signal = options.signal;
            if (signal)
                this.activeTurnSignals.set(active.threadId, signal);
            const onAbort = () => this.interruptTurn(proc, active);
            signal?.addEventListener('abort', onAbort, { once: true });
            try {
                yield* active.pump.step();
            }
            finally {
                signal?.removeEventListener('abort', onAbort);
                if (active.pump.turnOutcome)
                    this.closeActiveTurn(liveKey, active);
            }
            return;
        }
        // A finished turn may linger (its final echo concluded the DSH turn, so
        // no continuation stream call observed the outcome); drop it now.
        if (active)
            this.closeActiveTurn(liveKey, active);
        const session = await this.establishSession(provider, profile, proc, options);
        if (options.model && options.model !== session.model) {
            session.model = options.model;
            this.persistSession(provider, session);
        }
        const turns = extractUserTurns(options.messages);
        const overlap = overlapLength(session.sentUserTurns, turns);
        let unsent = turns.slice(overlap);
        if (overlap === 0 && session.sentUserTurns.length > 0 && turns.length > 0) {
            // History was rewritten in a way we cannot align (e.g. heavy compaction):
            // keep the live codex thread but forward only the newest human turn.
            this.deps.logger(`codex: history realignment for thread ${session.threadId}; forwarding only the latest human turn`);
            unsent = turns.slice(-1);
            session.sentUserTurns = [];
        }
        if (unsent.length === 0) {
            yield { type: 'finish', reason: { kind: 'stop' } };
            return;
        }
        // Bridged approval requests cite this signal so a DSH stop withdraws the
        // pending question instead of leaving it parked. Registered before the
        // backlog because those turns run through the same approval surface.
        const signal = options.signal;
        if (signal)
            this.activeTurnSignals.set(session.threadId, signal);
        const last = unsent[unsent.length - 1];
        const useToolBlocks = this.ensureDisplayTools(liveKey, session.dshKey);
        const pump = new TurnPump((size) => {
            this.learnedContextWindow.set(provider, size);
            this.persistSession(provider, session);
        }, this.deps.logger, this.toolOutcomes, useToolBlocks, (outcome) => {
            // Record the fingerprint as soon as the turn completes codex-side —
            // independent of whether any further stream call observes it (the
            // final echo may conclude the DSH turn before one runs). An
            // interrupted or failed turn is re-sent on the next stream call.
            if (outcome.status === 'completed') {
                session.sentUserTurns.push(last.fingerprint);
                this.persistSession(provider, session);
            }
        });
        const entry = {
            threadId: session.threadId,
            pump,
            disposeListener: proc.onThreadNotification(session.threadId, (notification) => pump.onNotification(notification)),
        };
        this.activeTurns.set(liveKey, entry);
        let aborted = false;
        const onAbort = () => {
            aborted = true;
            this.interruptTurn(proc, entry);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            // Rebuild codex-side context for any backlog silently; stream only the last turn.
            for (const turn of unsent.slice(0, -1)) {
                await this.runTurnSilently(proc, session.threadId, await this.toInputItems(turn));
                session.sentUserTurns.push(turn.fingerprint);
                this.persistSession(provider, session);
            }
            const startParams = {
                threadId: session.threadId,
                input: await this.toInputItems(last),
            };
            // Per-turn overrides become the thread defaults for subsequent turns —
            // exactly the semantics of the harness session model picker.
            if (options.model)
                startParams.model = options.model;
            if (options.reasoningEffort)
                startParams.effort = options.reasoningEffort;
            // codex sandbox / approval follow the DSH session's permission mode,
            // re-evaluated on every turn so a runtime switch takes effect immediately.
            Object.assign(startParams, this.turnPermissionParams(profile, session));
            const started = await proc.request('turn/start', startParams);
            pump.setTurnId(started.turn.id);
            if (aborted)
                this.interruptTurn(proc, entry);
            yield* pump.step();
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            // The approval signal mapping lives until the turn closes: a bridged
            // approval can arrive on any later step of this codex turn.
            if (pump.turnOutcome)
                this.closeActiveTurn(liveKey, entry);
        }
    }
    async toInputItems(turn) {
        const items = [];
        if (turn.text)
            items.push({ type: 'text', text: turn.text });
        for (const ref of turn.images) {
            try {
                const stored = await this.deps.readImage(ref);
                items.push({ type: 'image', url: `data:${ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` });
            }
            catch (error) {
                this.deps.logger(`codex: dropping unreadable image attachment ${ref.attachmentId}: ${error}`);
            }
        }
        if (items.length === 0)
            items.push({ type: 'text', text: '' });
        return items;
    }
    /**
     * Delete one session's ENGINE-side state: the codex thread and the stored
     * mapping. Called when the owning DSH session no longer exists, so the
     * engine never accumulates orphan threads. Best effort per session: a
     * failed thread/delete still drops the mapping (the thread becomes
     * unreachable), and an in-flight turn for the session makes the delete a
     * no-op (the next reconciliation retries).
     */
    async deleteEngineSession(provider, dshSessionId) {
        const stored = this.deps.store.get(provider, dshSessionId);
        if (stored === undefined)
            return false;
        const liveKey = `${provider}/${dshSessionId}`;
        if (this.activeTurns.has(liveKey))
            return false;
        try {
            const profile = this.profileFor(provider);
            const proc = this.ensureProcess(provider, profile);
            await proc.ensureStarted();
            await proc.request('thread/delete', { threadId: stored.threadId });
        }
        catch (error) {
            this.deps.logger(`codex: thread/delete failed for ${stored.threadId} (${error}); dropping mapping anyway`);
        }
        this.liveSessions.delete(liveKey);
        this.deps.store.deleteSession(provider, dshSessionId);
        return true;
    }
    /** Stored session ids of one route, for external reconciliation scans. */
    storedSessionIds(provider) {
        return this.deps.store.sessionIds(provider);
    }

    /** Stop every app-server process (plugin dispose). */
    dispose() {
        for (const entry of this.activeTurns.values())
            entry.disposeListener();
        this.activeTurns.clear();
        this.activeTurnSignals.clear();
        // Settle any echo still awaiting an outcome so tool executions drain.
        this.toolOutcomes.publishAll(true, 'interrupted');
        for (const proc of this.processes.values())
            proc.dispose();
        this.processes.clear();
        this.liveSessions.clear();
    }
}
export { CodexRpcError, CodexTransportError };
/**
 * The session-title-llm provider frames source messages as
 * `Generate the session title from this JSON array of human messages:\n<json>`
 * inside a plugin-sourced user message, so the genuine human text is one JSON
 * level down rather than in a `source.kind === 'user'` message.
 */
const TITLE_FRAME_MARKER = 'Generate the session title from this JSON array of human messages:\n';
/** First non-empty text found in a framed JSON structure. */
function findFirstText(node) {
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = findFirstText(item);
            if (found)
                return found;
        }
        return undefined;
    }
    if (node && typeof node === 'object') {
        const record = node;
        // Accept both content blocks ({type: 'text', text}) and the title
        // provider's flattened message snapshots ({seq, text}).
        if ((record.type === undefined || record.type === 'text') && typeof record.text === 'string' && record.text.trim()) {
            return record.text;
        }
        for (const value of Object.values(record)) {
            const found = findFirstText(value);
            if (found)
                return found;
        }
    }
    return undefined;
}
/**
 * Derive a local session title from the request's first user-role message,
 * unwrapping the session-title-llm framing when present. Returns undefined
 * when nothing usable is found.
 */
function titleFrom(messages) {
    const first = messages.find((m) => m.role === 'user');
    const raw = first?.content.find((b) => b.type === 'text');
    if (!raw || raw.type !== 'text')
        return undefined;
    let text = raw.text;
    if (text.startsWith(TITLE_FRAME_MARKER)) {
        // Never surface the framing instruction itself as a title: when the
        // framed payload yields nothing, give up rather than slice the marker.
        try {
            return findFirstText(JSON.parse(text.slice(TITLE_FRAME_MARKER.length)))?.split('\n')[0].trim().slice(0, 40) || undefined;
        }
        catch {
            return undefined;
        }
    }
    return text.split('\n')[0].trim().slice(0, 40) || undefined;
}
