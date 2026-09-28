const OUTPUT_TAIL_CHARS = 1500;
function textBlock(text) {
    return { type: 'text', text };
}
/** Registry of in-flight codex item outcomes, keyed by codex item id. */
export class CodexToolOutcomes {
    pending = new Map();
    /** Register a pending outcome when the codex item starts. */
    begin(itemId) {
        if (this.pending.has(itemId))
            return;
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        this.pending.set(itemId, { promise, resolve });
    }
    /** Publish the item's outcome; `final` marks turn-terminal results. */
    publish(itemId, outcome) {
        const entry = this.pending.get(itemId);
        if (!entry)
            return;
        this.pending.delete(itemId);
        entry.resolve({ ...outcome, final: outcome.final ?? false });
    }
    /** Resolve every outstanding outcome (turn completed / interrupted). */
    publishAll(final, status) {
        for (const [itemId, entry] of [...this.pending]) {
            this.pending.delete(itemId);
            entry.resolve({ status, final });
        }
    }
    /** True when no outcome is pending for the item (e.g. replayed calls). */
    isPending(itemId) {
        return this.pending.has(itemId);
    }
    /** Wait for one item's outcome; resolves 'interrupted' on abort. */
    awaitOutcome(itemId, signal) {
        const entry = this.pending.get(itemId);
        if (!entry)
            return Promise.resolve({ status: 'unknown', final: false });
        if (signal.aborted)
            return Promise.resolve({ status: 'interrupted', final: false });
        return new Promise((resolve) => {
            const onAbort = () => resolve({ status: 'interrupted', final: false });
            signal.addEventListener('abort', onAbort, { once: true });
            entry.promise.then((outcome) => {
                signal.removeEventListener('abort', onAbort);
                resolve(outcome);
            });
        });
    }
}
function asRecord(value) {
    return value && typeof value === 'object' ? value : {};
}
function asString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
function tailOutput(output) {
    const trimmed = output.trim();
    return trimmed.length > OUTPUT_TAIL_CHARS ? `…\n${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed;
}
/**
 * Build the four display-only tool definitions. `outcomes` is shared with the
 * adapter; `concludeIfFinal` behavior is what lets the agent loop finish the
 * turn right after the last echo instead of running one more empty step.
 */
export function codexDisplayTools(outcomes, dynamicSpecs = []) {
    const echo = async (callId, signal, concludeTurn) => {
        const outcome = await outcomes.awaitOutcome(callId, signal);
        if (outcome.final)
            concludeTurn();
        return outcome;
    };
    const command = {
        name: 'codex_command',
        description: 'Display mirror of a shell command codex executed in its own environment. Never dispatches work; replays the recorded outcome.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string' },
                cwd: { type: 'string' },
            },
            required: ['command'],
        },
        output: {
            schema: { type: 'object' },
            render: (args, value) => {
                const a = asRecord(args);
                const v = asRecord(value);
                const output = tailOutput(asString(v.output));
                const exit = typeof v.exitCode === 'number' ? `exit ${v.exitCode}` : asString(v.status, 'completed');
                return [textBlock(`$ ${asString(a.command)}\n(${exit})${output ? `\n${output}` : ''}`)];
            },
            presentationMeta: (_args, value) => {
                const v = asRecord(value);
                return {
                    output: tailOutput(asString(v.output)),
                    ...(typeof v.exitCode === 'number' ? { exitCode: v.exitCode } : {}),
                    ...(typeof v.durationMs === 'number' ? { durationMs: v.durationMs } : {}),
                    status: asString(v.status, 'completed'),
                };
            },
        },
        execute: (_args, exec) => echo(exec.callId, exec.signal, () => exec.concludeTurn()),
        presentCall: (args) => {
            const a = asRecord(args);
            return {
                card: 'terminal',
                title: asString(a.command, 'command'),
                ...(asString(a.cwd) ? { cwd: asString(a.cwd) } : {}),
            };
        },
        presentResult: (_args, result) => {
            const meta = asRecord(result.meta);
            if (result.isError)
                return { card: 'terminal', output: result.content.map((b) => b.type === 'text' ? b.text : '').join('\n') };
            return {
                card: 'terminal',
                ...(meta.output ? { output: asString(meta.output) } : {}),
                ...(typeof meta.exitCode === 'number' ? { exitCode: meta.exitCode } : {}),
            };
        },
        isConcurrencySafe: () => true,
    };
    const fileChange = {
        name: 'codex_file_change',
        description: 'Display mirror of a file change codex applied in its own environment. Never dispatches work; replays the recorded outcome.',
        parameters: {
            type: 'object',
            properties: {
                changes: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            kind: { type: 'string' },
                            diff: { type: 'string' },
                        },
                        required: ['path'],
                    },
                },
            },
            required: ['changes'],
        },
        output: {
            schema: { type: 'object' },
            render: (args, value) => {
                const a = asRecord(args);
                const v = asRecord(value);
                const changes = Array.isArray(a.changes) ? a.changes : [];
                const lines = changes.map((c) => `${asString(c.kind, 'update')}: ${asString(c.path)}`).join('\n');
                return [textBlock(`${lines}\n(${asString(v.status, 'completed')})`)];
            },
        },
        execute: (_args, exec) => echo(exec.callId, exec.signal, () => exec.concludeTurn()),
        presentCall: (args) => {
            const a = asRecord(args);
            const changes = Array.isArray(a.changes) ? a.changes : [];
            const paths = changes.map((c) => asString(c.path)).filter(Boolean);
            const diffs = changes.map((c) => asString(c.diff)).filter(Boolean).join('\n');
            return {
                card: 'generic',
                title: `Edit ${paths.join(', ') || 'files'}`,
                kind: 'edit',
                locations: paths.map((path) => ({ path })),
                ...(diffs ? { content: [textBlock(`\`\`\`diff\n${diffs}\n\`\`\``)] } : {}),
            };
        },
        presentResult: (args, result) => {
            const a = asRecord(args);
            const changes = Array.isArray(a.changes) ? a.changes : [];
            const paths = changes.map((c) => asString(c.path)).filter(Boolean);
            return {
                card: 'generic',
                title: `Edit ${paths.join(', ') || 'files'} (${result.isError ? 'failed' : 'completed'})`,
            };
        },
        isConcurrencySafe: () => true,
    };
    const mcpTool = {
        name: 'codex_mcp_tool',
        description: 'Display mirror of an MCP tool codex called in its own environment. Never dispatches work; replays the recorded outcome.',
        parameters: {
            type: 'object',
            properties: {
                server: { type: 'string' },
                tool: { type: 'string' },
                arguments: {},
            },
            required: ['server', 'tool'],
        },
        output: {
            schema: { type: 'object' },
            render: (args, value) => {
                const a = asRecord(args);
                const v = asRecord(value);
                return [textBlock(`${asString(a.server)}/${asString(a.tool)} (${asString(v.status, 'completed')})`)];
            },
        },
        execute: (_args, exec) => echo(exec.callId, exec.signal, () => exec.concludeTurn()),
        presentCall: (args) => {
            const a = asRecord(args);
            return {
                card: 'generic',
                title: `MCP ${asString(a.server)} / ${asString(a.tool)}`,
                kind: 'other',
                ...(a.arguments !== undefined ? { rawInput: a.arguments } : {}),
            };
        },
        presentResult: (args, result) => {
            const a = asRecord(args);
            return { card: 'generic', title: `MCP ${asString(a.server)} / ${asString(a.tool)} (${result.isError ? 'failed' : 'completed'})` };
        },
        isConcurrencySafe: () => true,
    };
    const webSearch = {
        name: 'codex_web_search',
        description: 'Display mirror of a web search codex performed in its own environment. Never dispatches work; replays the recorded outcome.',
        parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
        },
        output: {
            schema: { type: 'object' },
            render: (args, value) => {
                const a = asRecord(args);
                const v = asRecord(value);
                return [textBlock(`web search: ${asString(a.query)} (${asString(v.status, 'completed')})`)];
            },
        },
        execute: (_args, exec) => echo(exec.callId, exec.signal, () => exec.concludeTurn()),
        presentCall: (args) => ({ card: 'generic', title: asString(asRecord(args).query, 'web search'), kind: 'search' }),
        presentResult: (args) => ({ card: 'generic', title: asString(asRecord(args).query, 'web search') }),
        isConcurrencySafe: () => true,
    };
    // One echo per CLIENT-declared dynamic tool (thread/start `dynamicTools`).
    // The agent loop executes these by NAME, so every name codex can call back
    // must exist here too — otherwise the loop cannot dispatch the mirrored
    // tool-call block. The echo replays whatever the callback recorded.
    const dynamic = (Array.isArray(dynamicSpecs) ? dynamicSpecs : [])
        .filter((spec) => spec && typeof spec.name === 'string' && spec.name !== '')
        .map((spec) => ({
        name: spec.name,
        description: `Display mirror of the DSH-side tool "${spec.name}" that this harness executes on codex's behalf. Never dispatches work; replays the recorded outcome.`,
        parameters: { type: 'object', additionalProperties: true },
        output: {
            schema: { type: 'object' },
            render: (_args, value) => {
                const v = asRecord(value);
                return [textBlock(typeof v.result === 'string' ? v.result : asString(v.status, 'completed'))];
            },
        },
        execute: (_args, exec) => echo(exec.callId, exec.signal, () => exec.concludeTurn()),
        presentCall: (args) => {
            const a = asRecord(args);
            const hint = a.prompt ?? a.description ?? a.command ?? '';
            return { card: 'generic', title: String(hint) !== '' ? String(hint).slice(0, 120) : spec.name, ...(hint !== '' ? { rawInput: a } : {}) };
        },
        presentResult: (_args, result) => ({
            card: 'generic',
            title: `${spec.name} (${result.isError ? 'failed' : 'completed'})`,
        }),
        isConcurrencySafe: () => true,
    }));
    return [command, fileChange, mcpTool, webSearch, ...dynamic];
}
