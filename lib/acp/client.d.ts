/** One ACP content block inside a prompt or an update. */
export interface AcpContentBlock {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
}
/** A `session/update` notification payload. */
export interface AcpSessionUpdate {
    sessionId: string;
    update: {
        sessionUpdate: string;
        [key: string]: unknown;
    };
}
/** A select-style config option as returned in `session/new` results. */
export interface AcpConfigOption {
    id: string;
    name: string;
    category?: string;
    type: string;
    currentValue?: string;
    options?: Array<{
        value: string;
        name: string;
        description?: string;
    }>;
}
export interface AcpSessionNewResult {
    sessionId: string;
    configOptions?: AcpConfigOption[];
}
export interface AcpPromptUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
}
export interface AcpPromptResult {
    stopReason: string;
    usage?: AcpPromptUsage;
}
export interface AcpInitializeResult {
    protocolVersion: number;
    agentCapabilities?: {
        loadSession?: boolean;
        promptCapabilities?: {
            image?: boolean;
            embeddedContext?: boolean;
        };
        [key: string]: unknown;
    };
    agentInfo?: {
        name?: string;
        version?: string;
    };
    authMethods?: Array<{
        id: string;
        name: string;
    }>;
}
/** JSON-RPC error surfaced from the agent. */
export declare class AcpRpcError extends Error {
    readonly code: number;
    readonly data: unknown;
    constructor(code: number, message: string, data?: unknown);
}
/** Transport-level failure (process died, write failed, startup failed). */
export declare class AcpTransportError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export interface AcpProcessOptions {
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    /** How to answer `session/request_permission` when no handler is wired. */
    permissionPolicy: 'allow' | 'deny';
    /**
     * Async decision hook for `session/request_permission` (e.g. bridging into
     * the harness approval stack). When absent, `permissionPolicy` answers.
     */
    onPermissionRequest?: (params: AcpPermissionRequestParams) => Promise<PermissionDecision>;
    logger: (message: string) => void;
}
/** One ACP permission option as offered by the agent. */
export interface AcpPermissionOption {
    optionId?: string;
    name?: string;
    kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}
/** `session/request_permission` params. */
export interface AcpPermissionRequestParams {
    sessionId?: string;
    toolCall?: {
        toolCallId?: string;
        title?: string;
        kind?: string;
        rawInput?: {
            command?: string;
            [key: string]: unknown;
        };
        locations?: Array<{
            path?: string;
        }>;
    };
    options?: AcpPermissionOption[];
}
/** Client-side decision for a permission request. */
export type PermissionDecision = 'allow' | 'allow_always' | 'deny' | 'cancel';
/**
 * Map a decision onto the agent's offered options. Grants select `allow_once`
 * (never `allow_always` — the harness approves one action at a time); denials
 * select `reject_once`; cancellation reports the cancelled outcome. Pure and
 * exported for tests.
 */
export declare function permissionOutcome(decision: PermissionDecision, options: AcpPermissionOption[]): Record<string, unknown>;
/**
 * One long-lived ACP agent process. Lazily spawned on first use, respawned on
 * unexpected exit; every in-flight request is rejected on transport loss so
 * callers can recover at the session layer.
 */
export declare class AcpProcess {
    readonly options: AcpProcessOptions;
    private child?;
    private nextId;
    private pending;
    private listeners;
    private capabilities?;
    private starting?;
    private disposed;
    constructor(options: AcpProcessOptions);
    /** Agent capabilities captured at initialize; undefined until first start. */
    get agentCapabilities(): AcpInitializeResult | undefined;
    /** Ensure the process is spawned and the initialize handshake has completed. */
    ensureStarted(): Promise<AcpInitializeResult>;
    private start;
    /** Reject every pending request and forget the dead child. */
    private teardown;
    private onLine;
    /** Agent→client requests: permission prompts go to the async handler (policy fallback); fs/terminal are refused (not advertised). */
    private onAgentRequest;
    private onNotification;
    private send;
    /** Send a JSON-RPC request and await its result. */
    request<T>(method: string, params: Record<string, unknown>): Promise<T>;
    private requestWithTimeout;
    /** Send a JSON-RPC notification (no response expected). */
    notify(method: string, params: Record<string, unknown>): void;
    /** Subscribe to `session/update` notifications for one ACP session. */
    onSessionUpdate(sessionId: string, cb: (update: AcpSessionUpdate['update']) => void): () => void;
    /** Stop the child and reject everything in flight. */
    dispose(): void;
}
