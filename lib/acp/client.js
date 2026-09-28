/**
 * ACP (Agent Client Protocol) stdio client: one child process speaking
 * newline-delimited JSON-RPC 2.0, with the client-side request surface
 * (permission / fs / terminal) and per-session update dispatch.
 *
 * @module dsh-agent-adapter/acp/client
 */
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
/** JSON-RPC error surfaced from the agent. */
export class AcpRpcError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.name = 'AcpRpcError';
        this.code = code;
        this.data = data;
    }
}
/** Transport-level failure (process died, write failed, startup failed). */
export class AcpTransportError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'AcpTransportError';
    }
}
/**
 * Map a decision onto the agent's offered options. Grants select `allow_once`
 * (never `allow_always` — the harness approves one action at a time); denials
 * select `reject_once`; cancellation reports the cancelled outcome. Pure and
 * exported for tests.
 */
export function permissionOutcome(decision, options) {
    if (decision === 'cancel')
        return { outcome: { outcome: 'cancelled' } };
    const pick = (kinds) => options.find((o) => o.kind && kinds.includes(o.kind))?.optionId;
    const optionId = decision === 'deny'
        ? (pick(['reject_once', 'reject_always']) ?? options[options.length - 1]?.optionId)
        : decision === 'allow_always'
            // Persistent grant: only the danger-full-access session preset derives this.
            ? (pick(['allow_always']) ?? pick(['allow_once']) ?? options[0]?.optionId)
            // Interactive grants are one-shot even when allow_always is offered.
            : (pick(['allow_once']) ?? options.find((o) => o.kind === 'allow_always')?.optionId ?? options[0]?.optionId);
    if (optionId === undefined)
        return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId } };
}
const CLIENT_INFO = { name: 'dsh-agent-adapter', version: '0.1.0' };
const PROTOCOL_VERSION = 1;
const STARTUP_TIMEOUT_MS = 30_000;
/**
 * One long-lived ACP agent process. Lazily spawned on first use, respawned on
 * unexpected exit; every in-flight request is rejected on transport loss so
 * callers can recover at the session layer.
 */
export class AcpProcess {
    options;
    child;
    nextId = 1;
    pending = new Map();
    listeners = new Map();
    capabilities;
    starting;
    disposed = false;
    constructor(options) {
        this.options = options;
    }
    /** Agent capabilities captured at initialize; undefined until first start. */
    get agentCapabilities() {
        return this.capabilities;
    }
    /** Ensure the process is spawned and the initialize handshake has completed. */
    ensureStarted() {
        if (this.disposed)
            return Promise.reject(new AcpTransportError('acp process is disposed'));
        if (this.capabilities)
            return Promise.resolve(this.capabilities);
        if (this.starting)
            return this.starting;
        this.starting = this.start()
            .then((caps) => {
            this.capabilities = caps;
            return caps;
        })
            .finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }
    async start() {
        const { command, args, cwd, env } = this.options;
        this.options.logger(`acp: spawning ${command} ${args.join(' ')} (cwd: ${cwd})`);
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
            this.options.logger(`acp: process error: ${error.message}`);
            this.teardown(new AcpTransportError(`acp agent process failed: ${error.message}`));
        });
        child.on('exit', (code, signal) => {
            this.options.logger(`acp: process exited (code=${code}, signal=${signal})`);
            this.teardown(new AcpTransportError(`acp agent process exited (code=${code}, signal=${signal})${stderr ? `: ${stderr.slice(-500)}` : ''}`));
        });
        const rl = readline.createInterface({ input: child.stdout });
        rl.on('line', (line) => this.onLine(line));
        try {
            const init = await this.requestWithTimeout('initialize', {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
                clientInfo: CLIENT_INFO,
            }, STARTUP_TIMEOUT_MS);
            this.options.logger(`acp: initialized ${init.agentInfo?.name ?? 'agent'} ${init.agentInfo?.version ?? ''}`);
            return init;
        }
        catch (error) {
            this.teardown(error instanceof Error ? error : new AcpTransportError(String(error)));
            throw error;
        }
    }
    /** Reject every pending request and forget the dead child. */
    teardown(cause) {
        const pending = [...this.pending.values()];
        this.pending.clear();
        this.capabilities = undefined;
        this.listeners.clear();
        const child = this.child;
        this.child = undefined;
        for (const entry of pending)
            entry.reject(cause);
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
            this.options.logger(`acp: ignoring non-JSON line: ${line.slice(0, 200)}`);
            return;
        }
        if (msg.method && msg.id !== undefined) {
            this.onAgentRequest(msg.id, msg.method, msg.params ?? {});
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
                entry.reject(new AcpRpcError(msg.error.code, msg.error.message, msg.error.data));
            else
                entry.resolve(msg.result);
        }
    }
    /** Agent→client requests: permission prompts go to the async handler (policy fallback); fs/terminal are refused (not advertised). */
    onAgentRequest(id, method, params) {
        if (method === 'session/request_permission') {
            const request = params;
            const options = request.options ?? [];
            const answer = async () => {
                if (this.options.onPermissionRequest) {
                    try {
                        return permissionOutcome(await this.options.onPermissionRequest(request), options);
                    }
                    catch (error) {
                        this.options.logger(`acp: permission handler failed, failing closed: ${error}`);
                        return permissionOutcome('deny', options);
                    }
                }
                return permissionOutcome(this.options.permissionPolicy === 'allow' ? 'allow' : 'deny', options);
            };
            void answer().then((result) => this.send({ jsonrpc: '2.0', id, result }), () => this.send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } }));
            return;
        }
        this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `dsh-agent-adapter: client method not supported: ${method}` } });
    }
    onNotification(method, params) {
        if (method !== 'session/update')
            return;
        const update = params;
        const set = this.listeners.get(update.sessionId);
        if (!set)
            return;
        for (const cb of set) {
            try {
                cb(update.update);
            }
            catch (error) {
                this.options.logger(`acp: session update listener failed: ${error}`);
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
            return Promise.reject(new AcpTransportError('acp process is disposed'));
        if (!this.child)
            return Promise.reject(new AcpTransportError('acp process is not started'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { method, resolve: resolve, reject });
            try {
                this.send({ jsonrpc: '2.0', id, method, params });
            }
            catch (error) {
                this.pending.delete(id);
                reject(error instanceof Error ? error : new AcpTransportError(String(error)));
            }
        });
    }
    requestWithTimeout(method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new AcpTransportError(`acp ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
            this.request(method, params).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
        });
    }
    /** Send a JSON-RPC notification (no response expected). */
    notify(method, params) {
        this.send({ jsonrpc: '2.0', method, params });
    }
    /** Subscribe to `session/update` notifications for one ACP session. */
    onSessionUpdate(sessionId, cb) {
        let set = this.listeners.get(sessionId);
        if (!set) {
            set = new Set();
            this.listeners.set(sessionId, set);
        }
        set.add(cb);
        return () => {
            set.delete(cb);
            if (set.size === 0)
                this.listeners.delete(sessionId);
        };
    }
    /** Stop the child and reject everything in flight. */
    dispose() {
        this.disposed = true;
        this.teardown(new AcpTransportError('acp process disposed'));
    }
}
