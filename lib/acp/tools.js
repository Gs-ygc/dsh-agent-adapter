const OUTPUT_TAIL_CHARS = 1500;
function textBlock(text) {
    return { type: 'text', text };
}
/** Registry of in-flight ACP tool-call outcomes, keyed by ACP toolCallId. */
export class AcpToolOutcomes {
    pending = new Map();
    /** Register a pending outcome when the tool-call block is emitted. */
    begin(toolCallId) {
        if (this.pending.has(toolCallId))
            return;
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        this.pending.set(toolCallId, { promise, resolve });
    }
    /** Publish the call's outcome; `final` marks turn-terminal results. */
    publish(toolCallId, outcome) {
        const entry = this.pending.get(toolCallId);
        if (!entry)
            return;
        this.pending.delete(toolCallId);
        entry.resolve({ ...outcome, final: outcome.final ?? false });
    }
    /** Resolve every outstanding outcome (plugin teardown). */
    publishAll(status) {
        for (const [id, entry] of [...this.pending]) {
            this.pending.delete(id);
            entry.resolve({ status, final: false });
        }
    }
    /** Wait for one call's outcome; resolves 'interrupted' on abort. */
    awaitOutcome(toolCallId, signal) {
        const entry = this.pending.get(toolCallId);
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
/** ACP kind vocabulary → DSH ToolCallKind (same words minus think/switch_mode). */
function callKind(kind) {
    switch (kind) {
        case 'read':
        case 'edit':
        case 'delete':
        case 'move':
        case 'search':
        case 'execute':
        case 'fetch':
            return kind;
        default:
            return 'other';
    }
}
/**
 * Build the three display-only tool definitions. `outcomes` is shared with the
 * adapter; the `concludeTurn` behavior is what lets the agent loop finish the
 * turn right after the last echo instead of running one more empty step.
 */
export function acpDisplayTools(outcomes) {
    const echo = async (callId, signal, concludeTurn) => {
        const outcome = await outcomes.awaitOutcome(callId, signal);
        if (outcome.final)
            concludeTurn();
        return outcome;
    };
    const command = {
        name: 'acp_command',
        description: 'Display mirror of a shell command the ACP agent executed in its own environment. Never dispatches work; replays the recorded outcome.',
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
        name: 'acp_file_change',
        description: 'Display mirror of a file change the ACP agent applied in its own environment. Never dispatches work; replays the recorded outcome.',
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
                const lines = changes.map((c) => `${asString(c.kind, 'edit')}: ${asString(c.path)}`).join('\n');
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
    const generic = {
        name: 'acp_tool',
        description: 'Display mirror of a tool the ACP agent called in its own environment. Never dispatches work; replays the recorded outcome.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                kind: { type: 'string' },
                path: { type: 'string' },
                rawInput: {},
            },
            required: ['title'],
        },
        output: {
            schema: { type: 'object' },
            render: (args, value) => {
                const a = asRecord(args);
                const v = asRecord(value);
                const output = tailOutput(asString(v.output));
                return [textBlock(`${asString(a.title, 'tool')} (${asString(v.status, 'completed')})${output ? `\n${output}` : ''}`)];
            },
            presentationMeta: (_args, value) => {
                const v = asRecord(value);
                return {
                    ...(asString(v.output) ? { output: tailOutput(asString(v.output)) } : {}),
                    status: asString(v.status, 'completed'),
                };
            },
        },
        execute: (_args, exec) => echo(exec.callId, exec.signal, () => exec.concludeTurn()),
        presentCall: (args) => {
            const a = asRecord(args);
            const kind = asString(a.kind);
            const path = asString(a.path);
            return {
                card: 'generic',
                title: asString(a.title, 'tool'),
                kind: callKind(kind),
                ...(path ? { locations: [{ path }] } : {}),
                ...(a.rawInput !== undefined ? { rawInput: a.rawInput } : {}),
            };
        },
        presentResult: (args, result) => {
            const a = asRecord(args);
            return { card: 'generic', title: `${asString(a.title, 'tool')} (${result.isError ? 'failed' : 'completed'})` };
        },
        isConcurrencySafe: () => true,
    };
    return [command, fileChange, generic];
}
