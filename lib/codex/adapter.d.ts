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
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { CodexRpcError, CodexTransportError } from './client.js';
import type { ResolvedProfile } from './config.js';
import { CodexSessionStore } from './store.js';
import { type DisplayToolDefinition } from './tools.js';
export interface CodexAdapterDeps {
    /** Current route → profile resolution (settings-hot). */
    profiles: () => Map<string, ResolvedProfile>;
    /** Resolve durable image bytes for prompt content. */
    readImage: (ref: ImageAttachmentRef) => Promise<{
        data: Uint8Array;
    }>;
    /** Durable DSH↔codex thread mapping. */
    store: CodexSessionStore;
    /**
     * Resolve a DSH session's workspace directory (its header cwd). Threads are
     * created in the session's own workspace so codex reads the project the
     * user actually opened, not the harness process's launch directory.
     */
    sessionCwd?: (dshSessionId: string) => string | undefined;
    /**
     * Resolve a DSH session's current permission (sandbox) mode:
     * 'read-only' | 'workspace-write' | 'danger-full-access'. codex's sandbox,
     * approval policy and approvals reviewer follow it on every turn.
     */
    sessionPermission?: (dshSessionId: string) => string | undefined;
    /**
     * Forward one codex approval request to the DSH approval service.
     * Undefined outcome fails closed.
     */
    requestApproval?: (request: {
        sessionId: string;
        kind: 'command' | 'fileChange' | 'permission';
        command?: string;
        reason?: string;
        signal?: AbortSignal;
    }) => Promise<'accept' | 'decline' | 'cancel' | undefined>;
    /**
     * Register the display-only codex tool definitions on the DSH agent owning
     * a session (agent-scoped, replacement semantics on re-registration).
     * Without it the adapter falls back to plain-text display blocks.
     */
    registerTools?: (dshSessionId: string, definitions: DisplayToolDefinition[]) => void;
    logger: (message: string) => void;
}
export declare class CodexAdapter extends LlmAdapter {
    private readonly deps;
    private processes;
    private modelCache;
    /** Full codex catalog entries (reasoning efforts, modalities) by model id. */
    private catalog;
    private learnedContextWindow;
    /** In-flight sessions keyed by `${route}/${dshKey}` to survive stream calls. */
    private liveSessions;
    /** Abort signal of the turn currently streaming on each codex thread. */
    private activeTurnSignals;
    /** In-flight codex turns keyed by liveKey; one codex turn spans several
     *  DSH steps (several stream() calls) when tool items are mirrored. */
    private activeTurns;
    /** Shared registry the display-only echo tools await their outcomes on. */
    private toolOutcomes;
    /** liveKeys whose display tools registered successfully. */
    private toolsReady;
    constructor(deps: CodexAdapterDeps);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(): ResolvedRetryPolicy;
    private profileFor;
    private ensureProcess;
    /** Drop processes and cached state for routes no longer configured. */
    reconcileRoutes(): void;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    private establishSession;
    /**
     * codex execution settings for the DSH session's current permission mode.
     * Profile `sandbox` / `approvalPolicy` settings are explicit operator
     * overrides; without a resolvable mode nothing is sent and codex falls back
     * to its own config.
     */
    private permissionBase;
    /** thread/start flavor: sandbox is the plain mode string. */
    private threadPermissionParams;
    /** turn/start flavor: sandbox is the structured SandboxPolicy object. */
    private turnPermissionParams;
    private persistSession;
    /** Locally answered auxiliary calls: never forwarded to codex. */
    private auxiliary;
    /**
     * Run one turn to completion without streaming (used to rebuild codex-side
     * context for backlog human turns after a history realignment).
     */
    private runTurnSilently;
    /** Register the display tools once per session; false forces text display. */
    private ensureDisplayTools;
    /** Send turn/interrupt for an active turn; safe before turn/start resolves. */
    private interruptTurn;
    /** Detach a finished turn: notification listener, signal mapping, entry. */
    private closeActiveTurn;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private toInputItems;
    /** Stop every app-server process (plugin dispose). */
    dispose(): void;
}
export { CodexRpcError, CodexTransportError };
