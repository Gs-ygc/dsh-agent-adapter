/** One user-input item inside a `turn/start` request. */
export interface CodexInputItem {
    type: string;
    text?: string;
    url?: string;
    path?: string;
    [key: string]: unknown;
}
/** A codex ThreadItem (tagged union); only the fields we read are typed. */
export interface CodexThreadItem {
    type: string;
    id: string;
    text?: string;
    phase?: string;
    summary?: string[];
    content?: Array<{
        type: string;
        text?: string;
    }>;
    command?: string;
    cwd?: string;
    status?: string;
    exitCode?: number | null;
    durationMs?: number | null;
    aggregatedOutput?: string;
    changes?: Array<{
        path: string;
        kind: string;
        diff?: string;
    }>;
    server?: string;
    tool?: string;
    query?: string;
    review?: string;
    [key: string]: unknown;
}
export interface CodexTurn {
    id: string;
    status: string;
    error?: {
        message: string;
        codexErrorInfo?: unknown;
        additionalDetails?: string | null;
    } | null;
    items?: CodexThreadItem[];
}
export interface CodexThread {
    id: string;
    ephemeral?: boolean;
    modelProvider?: string;
    status?: {
        type: string;
    };
    [key: string]: unknown;
}
export interface CodexTokenUsageBreakdown {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
}
export interface CodexThreadTokenUsage {
    total: CodexTokenUsageBreakdown;
    last: CodexTokenUsageBreakdown;
    modelContextWindow: number | null;
}
/** A `model/list` catalog entry. */
export interface CodexModel {
    id: string;
    model: string;
    displayName: string;
    description?: string;
    hidden?: boolean;
    isDefault?: boolean;
    defaultReasoningEffort?: string;
    supportedReasoningEfforts?: Array<{
        reasoningEffort: string;
        description?: string;
    }>;
    inputModalities?: string[];
}
export interface CodexInitializeResult {
    userAgent: string;
    codexHome: string;
    platformFamily: string;
    platformOs: string;
}
/** A server notification relevant to turn streaming. */
export interface CodexNotification {
    method: string;
    params: Record<string, unknown>;
}
/** JSON-RPC error surfaced from the app-server. */
export declare class CodexRpcError extends Error {
    readonly code: number;
    readonly data: unknown;
    constructor(code: number, message: string, data?: unknown);
}
/** Transport-level failure (process died, write failed, startup failed). */
export declare class CodexTransportError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** One approval request codex asked the client to decide. */
export interface CodexApprovalRequest {
    kind: 'command' | 'fileChange' | 'permission';
    threadId?: string;
    turnId?: string;
    itemId?: string;
    command?: string;
    cwd?: string;
    reason?: string;
    /** Requested permission profile (kind === 'permission'). */
    permissions?: unknown;
}
/** The decision a bridge returns; mapped onto the codex decision vocabulary. */
export type CodexApprovalDecision = 'accept' | 'decline' | 'cancel';
export interface CodexProcessOptions {
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    /**
     * Approval bridge: every codex approval / permission request is forwarded
     * here (the DSH approval service in production). Missing, throwing, or an
     * undefined return fails closed — the request is declined.
     */
    onApproval?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision | undefined>;
    logger: (message: string) => void;
}
/**
 * One long-lived `codex app-server` process. Lazily spawned on first use,
 * respawned on unexpected exit; every in-flight request is rejected on
 * transport loss so callers can recover at the thread layer.
 */
export declare class CodexProcess {
    readonly options: CodexProcessOptions;
    private child?;
    private nextId;
    private pending;
    /** Thread-scoped notification listeners, keyed by threadId. */
    private listeners;
    private initialized;
    private starting?;
    private disposed;
    constructor(options: CodexProcessOptions);
    /** Ensure the process is spawned and the initialize handshake has completed. */
    ensureStarted(): Promise<CodexInitializeResult>;
    private start;
    /** Reject every pending request and forget the dead child. */
    private teardown;
    private onLine;
    /**
     * Server→client requests: every approval / permission prompt is forwarded
     * to the onApproval bridge (fail-closed); user-input and elicitation
     * prompts are declined (there is no interactive user on this side);
     * everything else is refused.
     */
    private onServerRequest;
    /** Bridge one approval request to the DSH approval service; fail closed. */
    private answerBridged;
    private onNotification;
    private send;
    /** Send a JSON-RPC request and await its result. */
    request<T>(method: string, params: Record<string, unknown>): Promise<T>;
    private requestWithTimeout;
    /** Send a JSON-RPC notification (no response expected). */
    notify(method: string, params: Record<string, unknown>): void;
    /** Subscribe to notifications carrying the given threadId. */
    onThreadNotification(threadId: string, cb: (notification: CodexNotification) => void): () => void;
    /** Stop the child and reject everything in flight. */
    dispose(): void;
}
