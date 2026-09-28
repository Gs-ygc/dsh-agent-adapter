/**
 * AcpAdapter: serves DSH LLM routes backed by ACP agent processes.
 *
 * The semantic inversion at the heart of this adapter: the harness loop sends
 * a stateless full-history completion request, while the ACP agent owns a
 * stateful session and runs the whole agent turn itself. The adapter bridges
 * the two by delivering only NEW human turns (append-only watermark over
 * `source.kind === 'user'` messages) and translating session updates back
 * into the harness stream vocabulary. The agent's tools are its own: mirrored
 * `tool-call` blocks name display-only echo tools (see tools.ts) whose
 * execute() replays the recorded ACP outcome — never real work. Sessions
 * without a registered echo set fall back to text display blocks.
 *
 * @module dsh-agent-adapter/acp/adapter
 */
import { CallId, LlmAdapter, LlmError, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { AcpProcess, AcpRpcError, AcpTransportError, } from './client.js';
import { AcpToolOutcomes, acpDisplayTools } from './tools.js';
/** No automatic retry: a re-sent prompt would duplicate the turn agent-side. */
const NO_RETRY = {
    mode: 'normal',
    maxRetries: 0,
    retryableCodes: [],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
};
const MODEL_CACHE_TTL_MS = 5 * 60_000;
/** Per-tool display cap for streamed terminal output. */
const MAX_TOOL_OUTPUT_CHARS = 2000;
/** Extract human turns; tool results and plugin context never reach the agent. */
export function extractUserTurns(messages) {
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
export function overlapLength(sent, current) {
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
/**
 * Push-based chunk assembler: ACP session updates in, StreamChunks out. One
 * ACP turn maps to one or more DSH steps: text/reasoning deltas stream into
 * open blocks, and when a tool call's first `tool_call_update` arrives the
 * pump emits a complete `tool-call` block (naming a display-only echo tool)
 * and flushes the step with a `tool-calls` finish — the agent loop then
 * "executes" the echo, whose result the adapter publishes once ACP settles
 * the call (non-final) or completes the turn (final, which concludes the DSH
 * turn without a trailing empty step). Sessions without display tools fall
 * back to plain text display blocks. The pump object survives across the
 * per-step stream() calls of one ACP turn.
 */
export class TurnPump {
    learnContextWindow;
    outcomes;
    useToolBlocks;
    queue = [];
    waiter;
    done = false;
    blockIndex = -1;
    openType;
    openText = '';
    /** Legacy text-display state, only used when `useToolBlocks` is false. */
    openToolId;
    legacyTools = new Map();
    /** Every tool call seen this turn, by ACP toolCallId. */
    toolInfos = new Map();
    /** Tool calls whose echo block was emitted and still awaits an outcome. */
    pendingItems = new Set();
    /** Settled tool data, resolved at the next boundary or turn end. */
    settledItems = new Map();
    /** Set when the turn's terminal finish chunk has been pushed. */
    turnSettled = false;
    constructor(learnContextWindow, outcomes, useToolBlocks) {
        this.learnContextWindow = learnContextWindow;
        this.outcomes = outcomes;
        this.useToolBlocks = useToolBlocks;
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
    [Symbol.asyncIterator]() {
        return this.step()[Symbol.asyncIterator]();
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
    openBlock(type) {
        if (this.openType === type && this.openToolId === undefined)
            return;
        this.closeBlock();
        this.blockIndex += 1;
        this.openType = type;
        this.openText = '';
        this.push({ type: 'block-start', index: this.blockIndex, blockType: type });
    }
    closeBlock() {
        if (this.openType === undefined)
            return;
        const type = this.openType;
        const text = this.openText;
        this.openType = undefined;
        this.openText = '';
        this.openToolId = undefined;
        this.push({ type: 'block-end', index: this.blockIndex, block: { type, text } });
    }
    /** Self-contained one-shot display block (plans). */
    displayBlock(text) {
        this.closeBlock();
        this.blockIndex += 1;
        this.push({ type: 'block-start', index: this.blockIndex, blockType: 'text' });
        this.push({ type: 'text-delta', index: this.blockIndex, text });
        this.push({ type: 'block-end', index: this.blockIndex, block: { type: 'text', text } });
    }
    /** End the current DSH step with a `tool-calls` finish. */
    flushStep() {
        this.closeBlock();
        this.push({ type: 'finish', reason: { kind: 'tool-calls' } });
    }
    /** Resolve every settled call's echo; `final` only at turn end with no trailing chunks. */
    resolveSettled(final) {
        for (const [id, data] of [...this.settledItems]) {
            this.settledItems.delete(id);
            this.pendingItems.delete(id);
            this.outcomes.publish(id, { ...data, final });
        }
    }
    /** Publish a turn-terminal status for calls still in flight agent-side. */
    publishPending(status, final) {
        for (const id of [...this.pendingItems]) {
            this.pendingItems.delete(id);
            this.outcomes.publish(id, { status, final });
        }
    }
    /** Display-tool name for an ACP tool kind. */
    toolNameFor(kind) {
        switch (kind) {
            case 'execute': return 'acp_command';
            case 'edit':
            case 'delete':
            case 'move': return 'acp_file_change';
            default: return 'acp_tool';
        }
    }
    /** Merge one tool_call / tool_call_update payload into the accumulated info. */
    mergeToolInfo(id, update) {
        let info = this.toolInfos.get(id);
        if (!info) {
            info = { paths: [], output: '', outputChars: 0, truncated: false };
            this.toolInfos.set(id, info);
        }
        if (typeof update.kind === 'string')
            info.kind = update.kind;
        if (typeof update.title === 'string' && update.title)
            info.title = update.title;
        const rawInput = update.rawInput;
        if (rawInput && typeof rawInput === 'object') {
            if (typeof rawInput.command === 'string' && rawInput.command)
                info.command = rawInput.command;
            if (typeof rawInput.cwd === 'string' && rawInput.cwd)
                info.cwd = rawInput.cwd;
        }
        const locations = Array.isArray(update.locations) ? update.locations : [];
        for (const loc of locations) {
            if (typeof loc?.path === 'string' && loc.path && !info.paths.includes(loc.path))
                info.paths.push(loc.path);
        }
        const status = typeof update.status === 'string' ? update.status : undefined;
        if (status)
            info.status = status;
        const rawOutput = update.rawOutput;
        if (typeof rawOutput?.metadata?.exit === 'number')
            info.exitCode = rawOutput.metadata.exit;
        // Content entries carry streamed text output and edit diffs.
        const content = Array.isArray(update.content) ? update.content : [];
        for (const entry of content) {
            if (entry.type === 'content' && entry.content?.type === 'text' && entry.content.text) {
                const room = MAX_TOOL_OUTPUT_CHARS - info.outputChars;
                if (room > 0) {
                    const slice = entry.content.text.slice(0, room);
                    info.output += slice;
                    info.outputChars += slice.length;
                }
                else {
                    info.truncated = true;
                }
            }
            else if (entry.type === 'diff' && typeof entry.newText === 'string') {
                // Compact pseudo-diff for the card body (paths stay in `changes`).
                const before = typeof entry.oldText === 'string' ? entry.oldText : '';
                const diff = `--- ${entry.path ?? 'file'}\n+++ ${entry.path ?? 'file'}\n${before ? `-${before.slice(0, 400)}\n` : ''}+${entry.newText.slice(0, 400)}`;
                info.diffText = info.diffText ? `${info.diffText}\n${diff}` : diff;
            }
        }
        return info;
    }
    /** Emit the echo tool-call block for one ACP call and flush the step. */
    emitToolCall(id, info) {
        const name = this.toolNameFor(info.kind);
        const args = name === 'acp_command'
            ? { command: info.command ?? info.title ?? 'command', ...(info.cwd ? { cwd: info.cwd } : {}) }
            : name === 'acp_file_change'
                ? {
                    changes: (info.paths.length > 0 ? info.paths : ['file']).map((path, i) => ({
                        path,
                        ...(info.kind ? { kind: info.kind } : {}),
                        ...(i === 0 && info.diffText ? { diff: info.diffText } : {}),
                    })),
                }
                : {
                    title: info.title ?? info.kind ?? 'tool',
                    ...(info.kind ? { kind: info.kind } : {}),
                    ...(info.paths[0] ? { path: info.paths[0] } : {}),
                    ...(info.command ? { rawInput: { command: info.command } } : {}),
                };
        const argumentsText = JSON.stringify(args);
        this.outcomes.begin(id);
        this.pendingItems.add(id);
        this.closeBlock();
        this.blockIndex += 1;
        this.push({ type: 'block-start', index: this.blockIndex, blockType: 'tool-call' });
        this.push({ type: 'tool-call-delta', index: this.blockIndex, id: CallId(id), name, argumentsDelta: argumentsText });
        this.push({ type: 'block-end', index: this.blockIndex, block: { type: 'tool-call', id: CallId(id), name, arguments: argumentsText } });
        // Flush so the loop "executes" the echo now: the tool card appears in
        // running state while the agent is still working on the call.
        this.flushStep();
    }
    /** Tool-call handling in echo mode: emit once, settle into outcome data. */
    onToolBlockUpdate(id, update) {
        const info = this.mergeToolInfo(id, update);
        if (!this.pendingItems.has(id) && !this.settledItems.has(id)) {
            // A new call proves previously settled calls were not turn-terminal.
            this.resolveSettled(false);
            this.emitToolCall(id, info);
        }
        if (info.status === 'completed' || info.status === 'failed') {
            this.settledItems.set(id, {
                status: info.status,
                ...(info.output ? { output: info.truncated ? `${info.output}\n… (output truncated)` : info.output } : {}),
                ...(info.exitCode !== undefined ? { exitCode: info.exitCode } : {}),
            });
        }
    }
    /** Legacy text display (no echo tools on this session). */
    onToolTextUpdate(id, update) {
        let tool = this.legacyTools.get(id);
        if (!tool) {
            tool = { headerShown: false, done: false };
            this.legacyTools.set(id, tool);
        }
        if (tool.done)
            return;
        const info = this.mergeToolInfo(id, update);
        const delta = (text) => {
            if (!(this.openType === 'text' && this.openToolId === id)) {
                this.closeBlock();
                this.blockIndex += 1;
                this.openType = 'text';
                this.openToolId = id;
                this.openText = '';
                this.push({ type: 'block-start', index: this.blockIndex, blockType: 'text' });
            }
            this.openText += text;
            this.push({ type: 'text-delta', index: this.blockIndex, text });
        };
        if (!tool.headerShown) {
            delta(toolHeader(update));
            tool.headerShown = true;
        }
        const content = Array.isArray(update.content) ? update.content : [];
        for (const entry of content) {
            const text = entry.type === 'content' && entry.content?.type === 'text' ? entry.content.text : undefined;
            if (text)
                delta(text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (output truncated)\n` : text);
        }
        if (info.status === 'completed' || info.status === 'failed') {
            delta(info.status === 'completed'
                ? `\n✓${info.exitCode !== undefined ? ` exit ${info.exitCode}` : ''}\n`
                : `\n✗${info.exitCode !== undefined ? ` exit ${info.exitCode}` : ''}\n`);
            tool.done = true;
            this.closeBlock();
        }
    }
    onUpdate(update) {
        switch (update.sessionUpdate) {
            case 'agent_message_chunk': {
                const content = update.content;
                if (content?.type === 'text' && content.text) {
                    // Text after a settled tool proves that tool was not turn-terminal.
                    this.resolveSettled(false);
                    this.openBlock('text');
                    this.openText += content.text;
                    this.push({ type: 'text-delta', index: this.blockIndex, text: content.text });
                }
                break;
            }
            case 'agent_thought_chunk': {
                const content = update.content;
                if (content?.type === 'text' && content.text) {
                    this.resolveSettled(false);
                    this.openBlock('reasoning');
                    this.openText += content.text;
                    this.push({ type: 'reasoning-delta', index: this.blockIndex, text: content.text });
                }
                break;
            }
            case 'tool_call': {
                // Sparse pending announcement (generic title); stash it — the first
                // tool_call_update carries the real command/path and drives display.
                const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
                if (id)
                    this.mergeToolInfo(id, update);
                break;
            }
            case 'tool_call_update': {
                const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
                if (!id)
                    break;
                if (this.useToolBlocks)
                    this.onToolBlockUpdate(id, update);
                else
                    this.onToolTextUpdate(id, update);
                break;
            }
            case 'plan': {
                const entries = Array.isArray(update.entries) ? update.entries : [];
                if (entries.length > 0) {
                    this.resolveSettled(false);
                    const lines = entries.map((e) => `- [${e.status ?? 'pending'}] ${e.content ?? ''}`).join('\n');
                    this.displayBlock(`\n\n📋 ${lines}\n\n`);
                }
                break;
            }
            case 'usage_update': {
                const size = typeof update.size === 'number' ? update.size : undefined;
                if (size && size > 0)
                    this.learnContextWindow(size);
                break;
            }
            default:
                break;
        }
    }
    /** Terminal: resolve every echo, close open blocks, report usage, finish. */
    settle(result, error) {
        if (this.turnSettled)
            return;
        this.turnSettled = true;
        // Echoes conclude the DSH turn only when nothing follows the last tool
        // step: trailing text/reasoning queued since the last flush must still be
        // streamed by one more step, so its echo resolves as non-final. Failures
        // never conclude through an echo — the error finish rides the next step.
        const trailing = this.queue.length > 0;
        if (error) {
            this.resolveSettled(false);
            this.publishPending('failed', false);
            this.closeBlock();
            const code = error instanceof AcpRpcError
                ? `ACP_RPC_${error.code}`
                : error instanceof AcpTransportError ? 'ACP_TRANSPORT' : 'UNKNOWN';
            this.push({ type: 'finish', reason: { kind: 'error', failure: { message: error.message, code } } });
        }
        else if (result?.stopReason === 'cancelled') {
            this.resolveSettled(false);
            this.publishPending('interrupted', false);
            this.closeBlock();
            this.push({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'prompt cancelled', code: 'CANCELLED' } } });
        }
        else if (result?.stopReason === 'refusal') {
            this.resolveSettled(false);
            this.publishPending('failed', false);
            this.closeBlock();
            this.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'agent refused the prompt', code: 'REFUSAL' } } });
        }
        else {
            const final = !trailing;
            this.resolveSettled(final);
            this.publishPending('completed', final);
            this.closeBlock();
            const usage = result?.usage;
            if (usage && (usage.inputTokens || usage.outputTokens)) {
                const tokenUsage = {
                    inputTokens: usage.inputTokens ?? 0,
                    outputTokens: usage.outputTokens ?? 0,
                    ...(usage.cachedReadTokens ? { cacheReadTokens: usage.cachedReadTokens } : {}),
                    ...(usage.cachedWriteTokens ? { cacheWriteTokens: usage.cachedWriteTokens } : {}),
                    ...(usage.thoughtTokens ? { reasoningTokens: usage.thoughtTokens } : {}),
                };
                this.push({ type: 'usage', usage: tokenUsage });
            }
            if (result?.stopReason === 'max_tokens' || result?.stopReason === 'max_turn_requests') {
                this.push({ type: 'finish', reason: { kind: 'max-tokens' } });
            }
            else {
                this.push({ type: 'finish', reason: { kind: 'stop' } });
            }
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
export class AcpAdapter extends LlmAdapter {
    deps;
    processes = new Map();
    modelCache = new Map();
    learnedContextWindow = new Map();
    /** In-flight sessions keyed by `${route}/${dshKey}` to survive stream calls. */
    liveSessions = new Map();
    /** In-flight ACP turns keyed by liveKey; one ACP turn spans several DSH
     *  steps (several stream() calls) when tool calls are mirrored. */
    activeTurns = new Map();
    /** Shared registry the display-only echo tools await their outcomes on. */
    toolOutcomes = new AcpToolOutcomes();
    /** liveKeys whose display tools registered successfully. */
    toolsReady = new Set();
    constructor(deps) {
        super();
        this.deps = deps;
    }
    /** Register the display tools once per session; false forces text display. */
    ensureDisplayTools(liveKey, dshKey) {
        if (!dshKey || !this.deps.registerTools)
            return false;
        if (this.toolsReady.has(liveKey))
            return true;
        try {
            this.deps.registerTools(dshKey, acpDisplayTools(this.toolOutcomes));
            this.toolsReady.add(liveKey);
            return true;
        }
        catch (error) {
            this.deps.logger(`acp: display tool registration failed, using text display: ${error}`);
            return false;
        }
    }
    /** Detach a finished turn: notification listener, signal, scratch cleanup. */
    async closeActiveTurn(provider, liveKey, entry, proc) {
        if (this.activeTurns.get(liveKey) !== entry)
            return;
        this.activeTurns.delete(liveKey);
        entry.session.activeSignal = undefined;
        entry.disposeListener();
        // One-shot calls (no DSH session identity) close their scratch session.
        if (!entry.session.dshKey) {
            try {
                await proc.request('session/close', { sessionId: entry.session.acpSessionId });
            }
            catch { /* unsupported or gone */ }
        }
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
            throw new LlmError(`llm-acp: provider route "${provider}" is not configured; add it under the llm-acp providers settings section`, 'NO_ADAPTER');
        }
        return profile;
    }
    ensureProcess(provider, profile) {
        const existing = this.processes.get(provider);
        if (existing)
            return existing;
        const proc = new AcpProcess({
            command: profile.command,
            args: profile.args,
            cwd: profile.cwd ?? process.cwd(),
            env: profile.env,
            // 'auto' fails closed at the process level; the handler below derives
            // the real answer from the session's DSH permission knobs.
            permissionPolicy: profile.permissionPolicy === 'allow' ? 'allow' : 'deny',
            onPermissionRequest: async (params) => {
                // Fixed overrides answer directly; 'auto' derives from the owning DSH
                // session's permission knobs (full-access → allow_always, approval-never
                // → deny, otherwise bridge to the session's approval card).
                if (profile.permissionPolicy === 'allow')
                    return 'allow';
                if (profile.permissionPolicy === 'deny')
                    return 'deny';
                if (!this.deps.requestApproval)
                    return 'deny';
                const session = [...this.liveSessions.values()].find((s) => s.acpSessionId === params.sessionId);
                if (!session?.dshKey)
                    return 'deny';
                const toolCall = params.toolCall ?? {};
                const path = toolCall.locations?.find((l) => typeof l?.path === 'string')?.path;
                const details = {
                    toolName: `${provider}:${toolCall.title ?? toolCall.kind ?? 'tool'}`,
                    reason: [toolCall.kind, toolCall.rawInput?.command, path].filter((v) => typeof v === 'string' && v.length > 0).join(' — ') || undefined,
                    ...(session.activeSignal ? { signal: session.activeSignal } : {}),
                };
                return this.deps.requestApproval(session.dshKey, details);
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
        // ACP discloses models per session; interrogate a scratch session and close it.
        const session = await proc.request('session/new', { cwd: profile.cwd ?? process.cwd(), mcpServers: [] });
        try {
            const models = modelsFromConfigOptions(provider, session.configOptions, session.models, profile);
            const efforts = await this.discoverEfforts(proc, session.sessionId, models, session.configOptions);
            this.modelCache.set(provider, { at: Date.now(), models, efforts });
            return models;
        }
        finally {
            try {
                await proc.request('session/close', { sessionId: session.sessionId });
            }
            catch { /* close unsupported or already gone */ }
        }
    }
    /**
     * Discover per-model reasoning efforts. Agents disclose the thought-level
     * config option only for the session's CURRENT model (opencode: category
     * `thought_level` appears after selecting a reasoning-capable model), so
     * discovery walks every candidate on the scratch session, then restores the
     * initial selection. Models without the option simply get no entry.
     */
    async discoverEfforts(proc, sessionId, models, initial) {
        const efforts = new Map();
        const initialModel = currentModelOf(initial);
        for (const model of models) {
            try {
                const res = await setSessionOption(proc, sessionId, 'model', model.id);
                const thought = thoughtLevelOf(res.configOptions);
                if (thought && thought.options.length > 0) {
                    efforts.set(model.id, {
                        efforts: thought.options.map((value) => ({ id: ReasoningEffortId(value), name: value })),
                        ...(thought.current ? { defaultEffort: ReasoningEffortId(thought.current) } : {}),
                    });
                }
            }
            catch (error) {
                this.deps.logger(`acp: effort discovery skipped model "${model.id}": ${error}`);
            }
        }
        if (initialModel) {
            try {
                await setSessionOption(proc, sessionId, 'model', initialModel);
            }
            catch { /* best effort restore */ }
        }
        return efforts;
    }
    async resolveModel(provider, model) {
        const profile = this.profileFor(provider);
        const cached = this.modelCache.get(provider);
        const known = cached?.models.find((m) => m.id === model);
        const reasoning = cached?.efforts.get(model);
        return {
            provider,
            id: model,
            name: known?.name ?? model,
            context: { contextWindow: this.learnedContextWindow.get(provider) ?? profile.defaultContextWindow },
            defaultMaxTokens: profile.defaultMaxTokens,
            ...(reasoning ? { reasoning } : {}),
        };
    }
    async establishSession(provider, profile, proc, options) {
        const dshKey = options.sessionId;
        // The ACP session's project root is the DSH SESSION's workspace; the
        // profile cwd only seeds the agent process and serves as fallback.
        const cwd = (dshKey && this.deps.resolveSessionCwd?.(dshKey)) || profile.cwd || process.cwd();
        const liveKey = `${provider}/${dshKey ?? ''}`;
        if (dshKey) {
            const live = this.liveSessions.get(liveKey);
            if (live)
                return live;
            const stored = this.deps.store.get(provider, dshKey);
            if (stored) {
                try {
                    await proc.request('session/load', { sessionId: stored.acpSessionId, cwd: stored.cwd, mcpServers: [] });
                    const revived = { ...stored, sentUserTurns: [...stored.sentUserTurns], dshKey };
                    this.liveSessions.set(liveKey, revived);
                    return revived;
                }
                catch (error) {
                    this.deps.logger(`acp: session/load failed for ${stored.acpSessionId}, creating a fresh session: ${error}`);
                }
            }
        }
        const created = await proc.request('session/new', { cwd, mcpServers: [] });
        const session = {
            acpSessionId: created.sessionId,
            cwd,
            sentUserTurns: [],
            ...(dshKey ? { dshKey } : {}),
        };
        const current = currentModelOf(created.configOptions);
        if (current)
            session.model = current;
        session.effort = thoughtLevelOf(created.configOptions)?.current;
        if (options.model && options.model !== session.model) {
            const res = await setSessionOption(proc, session.acpSessionId, 'model', options.model);
            session.model = options.model;
            // The new model carries its own effort default; re-read it when disclosed.
            session.effort = thoughtLevelOf(res?.configOptions)?.current ?? session.effort;
        }
        if (dshKey) {
            this.liveSessions.set(liveKey, session);
            this.persistSession(provider, session);
        }
        return session;
    }
    persistSession(provider, session) {
        if (!session.dshKey)
            return;
        const stored = {
            acpSessionId: session.acpSessionId,
            cwd: session.cwd,
            sentUserTurns: [...session.sentUserTurns],
            ...(session.model ? { model: session.model } : {}),
            ...(session.effort ? { effort: session.effort } : {}),
            ...(this.learnedContextWindow.get(provider) ? { contextWindow: this.learnedContextWindow.get(provider) } : {}),
        };
        this.deps.store.set(provider, session.dshKey, stored);
    }
    /** Locally answered auxiliary calls: never forwarded to the agent. */
    async *auxiliary(options) {
        let text;
        if (options.purpose === 'session-title') {
            // dsh-session-title-llm frames the selected human messages as a JSON
            // array inside ONE plugin-kind message, so the user-kind filter used for
            // agent forwarding does not apply here — nothing leaves the process.
            text = synthesizeTitle(options.messages);
        }
        else {
            text = 'Earlier conversation omitted; the ACP agent retains full session context internally.';
        }
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
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
        // Continuation step of an in-flight ACP turn: the previous step ended
        // with a `tool-calls` finish, the loop executed the echo tools, and now
        // asks for the next step. No new prompt is sent agent-side.
        const active = this.activeTurns.get(liveKey);
        if (active && !active.pump.turnSettled) {
            const signal = options.signal;
            active.session.activeSignal = signal;
            const onAbort = () => {
                proc.notify('session/cancel', { sessionId: active.session.acpSessionId });
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            try {
                yield* active.pump.step();
            }
            finally {
                signal?.removeEventListener('abort', onAbort);
                if (active.pump.turnSettled)
                    await this.closeActiveTurn(provider, liveKey, active, proc);
                else
                    active.session.activeSignal = undefined;
            }
            return;
        }
        // A finished turn may linger (its final echo concluded the DSH turn, so
        // no continuation stream call observed the outcome); drop it now.
        if (active)
            await this.closeActiveTurn(provider, liveKey, active, proc);
        const session = await this.establishSession(provider, profile, proc, options);
        // Model switch requested by the harness (session model changed).
        if (options.model && options.model !== session.model) {
            const res = await setSessionOption(proc, session.acpSessionId, 'model', options.model);
            session.model = options.model;
            session.effort = thoughtLevelOf(res?.configOptions)?.current ?? session.effort;
            this.persistSession(provider, session);
        }
        // Reasoning effort selected in the harness, when the current model exposes one.
        if (options.reasoningEffort && options.reasoningEffort !== session.effort) {
            try {
                await setSessionOption(proc, session.acpSessionId, 'effort', options.reasoningEffort);
                session.effort = options.reasoningEffort;
                this.persistSession(provider, session);
            }
            catch (error) {
                this.deps.logger(`acp: effort "${options.reasoningEffort}" not accepted for model "${session.model}": ${error}`);
            }
        }
        const turns = extractUserTurns(options.messages);
        const overlap = overlapLength(session.sentUserTurns, turns);
        let unsent = turns.slice(overlap);
        if (overlap === 0 && session.sentUserTurns.length > 0 && turns.length > 0) {
            // History was rewritten in a way we cannot align (e.g. heavy compaction):
            // keep the live agent session but forward only the newest human turn.
            this.deps.logger(`acp: history realignment for session ${session.acpSessionId}; forwarding only the latest human turn`);
            unsent = turns.slice(-1);
            session.sentUserTurns = [];
        }
        if (unsent.length === 0) {
            yield { type: 'finish', reason: { kind: 'stop' } };
            return;
        }
        // Rebuild agent-side context for any backlog silently; stream only the last turn.
        for (const turn of unsent.slice(0, -1)) {
            await proc.request('session/prompt', {
                sessionId: session.acpSessionId,
                prompt: await this.toPromptBlocks(turn),
            });
            session.sentUserTurns.push(turn.fingerprint);
            this.persistSession(provider, session);
        }
        const last = unsent[unsent.length - 1];
        const useToolBlocks = this.ensureDisplayTools(liveKey, session.dshKey);
        const pump = new TurnPump((size) => {
            this.learnedContextWindow.set(provider, size);
            this.persistSession(provider, session);
        }, this.toolOutcomes, useToolBlocks);
        const entry = {
            session,
            pump,
            disposeListener: proc.onSessionUpdate(session.acpSessionId, (update) => pump.onUpdate(update)),
        };
        this.activeTurns.set(liveKey, entry);
        const signal = options.signal;
        const onAbort = () => {
            // ACP cancellation is a notification; opencode rejects the request form.
            proc.notify('session/cancel', { sessionId: session.acpSessionId });
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        // Permission asks arriving during this turn inherit its abort signal.
        session.activeSignal = signal;
        const settled = proc.request('session/prompt', {
            sessionId: session.acpSessionId,
            prompt: await this.toPromptBlocks(last),
        });
        settled.then((result) => {
            session.sentUserTurns.push(last.fingerprint);
            this.persistSession(provider, session);
            pump.settle(result, undefined);
        }, (error) => pump.settle(undefined, error instanceof Error ? error : new Error(String(error))));
        try {
            yield* pump.step();
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            if (pump.turnSettled)
                await this.closeActiveTurn(provider, liveKey, entry, proc);
            else
                session.activeSignal = undefined;
        }
    }
    async toPromptBlocks(turn) {
        const blocks = [];
        if (turn.text)
            blocks.push({ type: 'text', text: turn.text });
        for (const ref of turn.images) {
            try {
                const stored = await this.deps.readImage(ref);
                blocks.push({ type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: ref.mediaType });
            }
            catch (error) {
                this.deps.logger(`acp: dropping unreadable image attachment ${ref.attachmentId}: ${error}`);
            }
        }
        if (blocks.length === 0)
            blocks.push({ type: 'text', text: '' });
        return blocks;
    }
    /** Stop every agent process (plugin dispose). */
    dispose() {
        // Publish before disposing processes so no echo outlives the adapter.
        this.toolOutcomes.publishAll('disposed');
        for (const entry of this.activeTurns.values())
            entry.disposeListener();
        this.activeTurns.clear();
        this.toolsReady.clear();
        for (const proc of this.processes.values())
            proc.dispose();
        this.processes.clear();
        this.liveSessions.clear();
    }
}
/**
 * Set one session option across the ACP naming variants in the wild.
 * The protocol settled on `session/set_config_option`, but shipped agents use
 * older spellings — claude-code-acp 0.16 answers `session/set_model`, others use
 * camelCase `setModel`. Try the canonical call first, then the fallbacks, so one
 * adapter serves every ACP agent instead of hard-failing on a name difference.
 * Returns the response object (for option re-reads) or undefined when unsupported.
 */
async function setSessionOption(proc, sessionId, configId, value) {
    const variants = configId === 'model'
        ? [
            ['session/set_config_option', { sessionId, configId, value }],
            ['session/set_model', { sessionId, modelId: value }],
            ['session/setModel', { sessionId, modelId: value }],
        ]
        : [
            ['session/set_config_option', { sessionId, configId, value }],
        ];
    for (const [method, params] of variants) {
        try {
            return await proc.request(method, params);
        }
        catch (error) {
            const message = String(error?.message ?? error);
            // "Method not found" is a naming mismatch: try the next spelling.
            if (!/method not found|-32601/i.test(message))
                throw error;
        }
    }
    return undefined;
}
function modelsFromConfigOptions(provider, configOptions, sessionModels, profile) {
    const modelOption = configOptions?.find((o) => o.category === 'model' || o.id === 'model');
    if (modelOption?.options)
        return modelOption.options.map((o) => ({ provider, id: o.value, name: o.name || o.value }));
    // Some ACP agents (claude-code-acp) disclose their catalog on `models`
    // (availableModels/currentModelId) instead of a `model` config option. When
    // the profile pins a model through the environment, that pinned model is the
    // only one the route really serves — advertise just it, so the picker cannot
    // offer an entry the configured endpoint will reject.
    const pinned = profile?.env?.ANTHROPIC_MODEL;
    if (typeof pinned === 'string' && pinned !== '')
        return [{ provider, id: pinned, name: pinned }];
    const available = sessionModels?.availableModels;
    if (Array.isArray(available))
        return available
            .filter((m) => m && typeof m.modelId === 'string' && m.modelId !== '')
            .map((m) => ({ provider, id: m.modelId, name: m.name || m.modelId }));
    return [];
}
/**
 * Synthesize a session title locally. dsh-session-title-llm frames the
 * selected human messages as a JSON array inside one plugin-kind message
 * (`...human messages:\n[...]`); recover the first message's text from that
 * frame, falling back to the raw first text block for unframed callers.
 */
export function synthesizeTitle(messages) {
    const FALLBACK = 'ACP session';
    const firstText = (m) => {
        if (!m)
            return undefined;
        const parts = m.content.filter((b) => b.type === 'text').map((b) => b.text);
        return parts.length > 0 ? parts.join('\n') : undefined;
    };
    let raw = firstText(messages.find((m) => m.role === 'user'));
    if (raw) {
        const frameStart = raw.indexOf('\n[');
        if (raw.includes('JSON array of human messages') && frameStart >= 0) {
            try {
                // dsh-session-title-llm serializes {seq, text} pairs (not full
                // message objects); accept content-block arrays too for robustness.
                const framed = JSON.parse(raw.slice(frameStart + 1));
                const inner = framed
                    .flatMap((m) => {
                    if (typeof m.text === 'string')
                        return [m.text];
                    return (m.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
                })
                    .join(' ');
                if (inner.trim())
                    raw = inner;
            }
            catch { /* fall through to the raw text */ }
        }
    }
    const title = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return title || FALLBACK;
}
function currentModelOf(configOptions) {
    const modelOption = configOptions?.find((o) => o.category === 'model' || o.id === 'model');
    return modelOption?.currentValue;
}
/** The thought-level config option, when the session's current model exposes one (opencode: id `effort`, category `thought_level`). */
function thoughtLevelOf(configOptions) {
    const option = configOptions?.find((o) => o.category === 'thought_level' || o.id === 'effort');
    if (!option)
        return undefined;
    return {
        ...(option.currentValue ? { current: option.currentValue } : {}),
        options: (option.options ?? []).map((o) => o.value),
    };
}
/** One-line display header for an ACP tool call: title, command, and path. */
function toolHeader(update) {
    const kind = typeof update.kind === 'string' ? update.kind : 'tool';
    const title = typeof update.title === 'string' ? update.title : '';
    const rawInput = update.rawInput;
    const command = typeof rawInput?.command === 'string' ? rawInput.command : undefined;
    const locations = Array.isArray(update.locations) ? update.locations : [];
    const path = locations.find((l) => typeof l?.path === 'string')?.path;
    const label = title || kind;
    const parts = [`\n\n⚙️ **${label}**`];
    if (command && command !== title)
        parts.push(`\`${command}\``);
    if (path)
        parts.push(`— \`${path}\``);
    parts.push('\n');
    return parts.join(' ');
}
