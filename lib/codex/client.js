/**
 * codex app-server stdio client: one child process speaking newline-delimited
 * JSON-RPC 2.0 (the `"jsonrpc"` header is omitted on the wire, per the
 * app-server protocol), with the server-initiated request surface (approvals,
 * permissions, user input, elicitations) answered per the configured
 * permission policy, and per-thread notification dispatch.
 *
 * Protocol reference: codex-rs/app-server/README.md. The wire shapes used here
 * were verified against `codex app-server generate-ts` output for codex-cli
 * 0.148.0.
 *
 * @module dsh-agent-adapter/codex/client
 */
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
/** JSON-RPC error surfaced from the app-server. */
export class CodexRpcError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.name = 'CodexRpcError';
        this.code = code;
        this.data = data;
    }
}
/** Transport-level failure (process died, write failed, startup failed). */
export class CodexTransportError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'CodexTransportError';
    }
}
const CLIENT_INFO = { name: 'dsh_agent_adapter', title: 'DSH agent adapter (codex half)', version: '0.1.0' };
const STARTUP_TIMEOUT_MS = 30_000;
/**
 * One long-lived `codex app-server` process. Lazily spawned on first use,
 * respawned on unexpected exit; every in-flight request is rejected on
 * transport loss so callers can recover at the thread layer.
 */
export class CodexProcess {
    options;
    child;
    nextId = 1;
    pending = new Map();
    /** Thread-scoped notification listeners, keyed by threadId. */
    listeners = new Map();
    initialized = false;
    starting;
    disposed = false;
    constructor(options) {
        this.options = options;
    }
    /** Ensure the process is spawned and the initialize handshake has completed. */
    ensureStarted() {
        if (this.disposed)
            return Promise.reject(new CodexTransportError('codex process is disposed'));
        if (this.initialized) {
            return Promise.resolve({
                userAgent: '', codexHome: '', platformFamily: '', platformOs: '',
            });
        }
        if (this.starting)
            return this.starting;
        this.starting = this.start()
            .then((info) => {
            this.initialized = true;
            return info;
        })
            .finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }
    async start() {
        const { command, args, cwd, env } = this.options;
        this.options.logger(`codex: spawning ${command} ${args.join(' ')} (cwd: ${cwd})`);
        const child = spawn(command, args, {
            cwd,
            env: env ? { ...process.env, ...env } : process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => {
            stderr += chunk;
            if (stderr.length > 64_000)
                stderr = stderr.slice(-32_000);
        });
        child.on('error', (error) => {
            this.options.logger(`codex: process error: ${error.message}`);
            this.teardown(new CodexTransportError(`codex app-server process failed: ${error.message}`));
        });
        child.on('exit', (code, signal) => {
            this.options.logger(`codex: process exited (code=${code}, signal=${signal})`);
            this.teardown(new CodexTransportError(`codex app-server process exited (code=${code}, signal=${signal})${stderr ? `: ${stderr.slice(-500)}` : ''}`));
        });
        const rl = readline.createInterface({ input: child.stdout });
        rl.on('line', (line) => this.onLine(line));
        try {
            const init = await this.requestWithTimeout('initialize', {
                clientInfo: CLIENT_INFO,
                capabilities: {
                    // Enables excludeTurns on thread/resume and other opt-in surfaces.
                    experimentalApi: true,
                },
            }, STARTUP_TIMEOUT_MS);
            // The handshake completes with the `initialized` notification; any
            // request sent before it is rejected by the server.
            this.notify('initialized', {});
            this.options.logger(`codex: initialized (${init.userAgent})`);
            return init;
        }
        catch (error) {
            this.teardown(error instanceof Error ? error : new CodexTransportError(String(error)));
            throw error;
        }
    }
    /** Reject every pending request and forget the dead child. */
    teardown(cause) {
        const pending = [...this.pending.values()];
        this.pending.clear();
        this.initialized = false;
        const listeners = [...this.listeners.values()];
        this.listeners.clear();
        const child = this.child;
        this.child = undefined;
        for (const entry of pending)
            entry.reject(cause);
        for (const set of listeners) {
            for (const cb of set) {
                try {
                    cb({ method: 'transport/lost', params: { message: cause.message } });
                }
                catch { /* listener failure is secondary */ }
            }
        }
        try {
            child?.kill('SIGTERM');
        }
        catch { /* already gone */ }
    }
    onLine(line) {
        if (!line.trim())
            return;
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            this.options.logger(`codex: ignoring non-JSON line: ${line.slice(0, 200)}`);
            return;
        }
        if (msg.method && msg.id !== undefined) {
            this.onServerRequest(msg.id, msg.method, msg.params ?? {});
            return;
        }
        if (msg.method) {
            this.onNotification(msg.method, msg.params ?? {});
            return;
        }
        if (msg.id !== undefined) {
            const entry = this.pending.get(Number(msg.id));
            if (!entry)
                return;
            this.pending.delete(Number(msg.id));
            if (msg.error)
                entry.reject(new CodexRpcError(msg.error.code, msg.error.message, msg.error.data));
            else
                entry.resolve(msg.result);
        }
    }
    /**
     * Server→client requests: every approval / permission prompt is forwarded
     * to the onApproval bridge (fail-closed); user-input and elicitation
     * prompts are declined (there is no interactive user on this side);
     * everything else is refused.
     */
    onServerRequest(id, method, params) {
        switch (method) {
            case 'item/commandExecution/requestApproval':
            case 'item/fileChange/requestApproval':
            case 'item/permissions/requestApproval': {
                const request = {
                    kind: method === 'item/commandExecution/requestApproval'
                        ? 'command'
                        : method === 'item/fileChange/requestApproval'
                            ? 'fileChange'
                            : 'permission',
                    ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
                    ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
                    ...(typeof params.itemId === 'string' ? { itemId: params.itemId } : {}),
                    ...(typeof params.command === 'string' ? { command: params.command } : {}),
                    ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
                    ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
                    ...(method === 'item/permissions/requestApproval' ? { permissions: params.permissions } : {}),
                };
                void this.answerBridged(id, request);
                return;
            }
            case 'item/tool/requestUserInput': {
                // No interactive user here: answer every question with empty input.
                this.send({ id, result: { answers: {} } });
                return;
            }
            case 'mcpServer/elicitation/request': {
                this.send({ id, result: { action: 'decline', content: null } });
                return;
            }
            case 'currentTime/read': {
                this.send({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
                return;
            }
            case 'item/tool/call': {
                // A tool the CLIENT declared via thread/start `dynamicTools`.
                // Answer asynchronously (a dynamic tool may run for a long time).
                void this.answerDynamicTool(id, params);
                return;
            }
            default:
                this.send({ id, error: { code: -32601, message: `dsh-agent-adapter: client method not supported: ${method}` } });
        }
    }
    /**
     * Answer one client-declared dynamic tool call. The declaration travels on
     * `thread/start.dynamicTools`; codex calls back here with
     * {@link https://github.com/openai/codex DynamicToolCallParams}, and expects
     * `{ success, contentItems }` in reply. A tool with no handler answers as a
     * failed call rather than a transport error, so the model sees the reason.
     */
    async answerDynamicTool(id, params) {
        const request = {
            threadId: String(params.threadId ?? ''),
            turnId: String(params.turnId ?? ''),
            callId: String(params.callId ?? ''),
            tool: String(params.tool ?? ''),
            namespace: params.namespace ?? null,
            arguments: params.arguments,
        };
        let result = {
            success: false,
            contentItems: [{ type: 'inputText', text: `no handler is registered for dynamic tool "${request.tool}"` }],
        };
        try {
            const answered = await this.options.onDynamicToolCall?.(request);
            if (answered !== undefined && answered !== null)
                result = answered;
        }
        catch (error) {
            result = {
                success: false,
                contentItems: [{ type: 'inputText', text: `dynamic tool "${request.tool}" failed: ${String(error?.message ?? error)}` }],
            };
        }
        this.send({ id, result });
    }
    /** Bridge one approval request to the DSH approval service; fail closed. */
    async answerBridged(id, request) {
        let decision = 'decline';
        try {
            decision = (await this.options.onApproval?.(request)) ?? 'decline';
        }
        catch (error) {
            this.options.logger(`codex: bridged approval failed, declining: ${error}`);
        }
        if (request.kind === 'permission') {
            // Permission requests answer with the granted subset, not a decision.
            this.send({
                id,
                result: decision === 'accept'
                    ? { scope: 'turn', permissions: request.permissions ?? {} }
                    : { permissions: {} },
            });
            return;
        }
        this.send({ id, result: { decision } });
    }
    onNotification(method, params) {
        const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
        if (!threadId)
            return;
        const set = this.listeners.get(threadId);
        if (!set)
            return;
        const notification = { method, params };
        for (const cb of set) {
            try {
                cb(notification);
            }
            catch (error) {
                this.options.logger(`codex: notification listener failed: ${error}`);
            }
        }
    }
    send(msg) {
        const child = this.child;
        if (!child?.stdin?.writable)
            return;
        child.stdin.write(JSON.stringify(msg) + '\n');
    }
    /** Send a JSON-RPC request and await its result. */
    request(method, params) {
        if (this.disposed)
            return Promise.reject(new CodexTransportError('codex process is disposed'));
        if (!this.child)
            return Promise.reject(new CodexTransportError('codex process is not started'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { method, resolve: resolve, reject });
            try {
                this.send({ id, method, params });
            }
            catch (error) {
                this.pending.delete(id);
                reject(error instanceof Error ? error : new CodexTransportError(String(error)));
            }
        });
    }
    requestWithTimeout(method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new CodexTransportError(`codex ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
            this.request(method, params).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
        });
    }
    /** Send a JSON-RPC notification (no response expected). */
    notify(method, params) {
        this.send({ method, params });
    }
    /** Subscribe to notifications carrying the given threadId. */
    onThreadNotification(threadId, cb) {
        let set = this.listeners.get(threadId);
        if (!set) {
            set = new Set();
            this.listeners.set(threadId, set);
        }
        set.add(cb);
        return () => {
            set.delete(cb);
            if (set.size === 0)
                this.listeners.delete(threadId);
        };
    }
    /** Stop the child and reject everything in flight. */
    dispose() {
        this.disposed = true;
        this.teardown(new CodexTransportError('codex process disposed'));
    }
}
