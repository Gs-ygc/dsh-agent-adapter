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
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type Message, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { type PermissionDecision, type AcpPromptResult } from './client.js';
import type { ResolvedProfile } from './config.js';
import { AcpSessionStore } from './store.js';
import { AcpToolOutcomes, type DisplayToolDefinition } from './tools.js';
/** One extracted human turn: the only messages ever forwarded to the agent. */
export interface UserTurn {
    /** Fingerprint used for append-only diffing (text plus image count). */
    fingerprint: string;
    text: string;
    images: ImageAttachmentRef[];
}
export interface AcpAdapterDeps {
    /** Current route → profile resolution (settings-hot). */
    profiles: () => Map<string, ResolvedProfile>;
    /** Resolve durable image bytes for prompt content. */
    readImage: (ref: ImageAttachmentRef) => Promise<{
        data: Uint8Array;
    }>;
    /** Durable DSH↔ACP session mapping. */
    store: AcpSessionStore;
    /**
     * Route an agent permission ask to the owning DSH session's approval stack.
     * Absent (or sessionless asks): the profile's permissionPolicy answers.
     */
    requestApproval?: (dshSessionId: string, details: {
        toolName: string;
        reason?: string;
        signal?: AbortSignal;
    }) => Promise<PermissionDecision>;
    /**
     * Register the display-only echo tools on a session's agent scope. When
     * absent (or the session has no DSH identity), tool calls fall back to text
     * display blocks.
     */
    registerTools?: (dshSessionId: string, definitions: DisplayToolDefinition[]) => void;
    /**
     * Resolve a DSH session's workspace directory (session header cwd). ACP
     * sessions must be created with the SESSION's workspace, not the harness
     * process cwd — otherwise the agent reads and acts on the wrong project.
     */
    resolveSessionCwd?: (dshSessionId: string) => string | undefined;
    logger: (message: string) => void;
}
/** Extract human turns; tool results and plugin context never reach the agent. */
export declare function extractUserTurns(messages: readonly Message[]): UserTurn[];
/**
 * Longest overlap where the tail of `sent` equals the head of `current`.
 * Covers both the append-only case (sent is a prefix of current) and
 * post-compaction history (current starts mid-way through sent).
 */
export declare function overlapLength(sent: readonly string[], current: readonly UserTurn[]): number;
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
export declare class TurnPump implements AsyncIterable<StreamChunk> {
    private readonly learnContextWindow;
    private readonly outcomes;
    private readonly useToolBlocks;
    private queue;
    private waiter?;
    private done;
    private blockIndex;
    private openType?;
    private openText;
    /** Legacy text-display state, only used when `useToolBlocks` is false. */
    private openToolId?;
    private legacyTools;
    /** Every tool call seen this turn, by ACP toolCallId. */
    private toolInfos;
    /** Tool calls whose echo block was emitted and still awaits an outcome. */
    private pendingItems;
    /** Settled tool data, resolved at the next boundary or turn end. */
    private settledItems;
    /** Set when the turn's terminal finish chunk has been pushed. */
    turnSettled: boolean;
    constructor(learnContextWindow: (size: number) => void, outcomes: AcpToolOutcomes, useToolBlocks: boolean);
    /** The chunks of one DSH step: yields until a finish chunk, then ends. */
    step(): AsyncIterable<StreamChunk>;
    [Symbol.asyncIterator](): AsyncIterator<StreamChunk>;
    private nextChunk;
    private push;
    private openBlock;
    private closeBlock;
    /** Self-contained one-shot display block (plans). */
    private displayBlock;
    /** End the current DSH step with a `tool-calls` finish. */
    private flushStep;
    /** Resolve every settled call's echo; `final` only at turn end with no trailing chunks. */
    private resolveSettled;
    /** Publish a turn-terminal status for calls still in flight agent-side. */
    private publishPending;
    /** Display-tool name for an ACP tool kind. */
    private toolNameFor;
    /** Merge one tool_call / tool_call_update payload into the accumulated info. */
    private mergeToolInfo;
    /** Emit the echo tool-call block for one ACP call and flush the step. */
    private emitToolCall;
    /** Tool-call handling in echo mode: emit once, settle into outcome data. */
    private onToolBlockUpdate;
    /** Legacy text display (no echo tools on this session). */
    private onToolTextUpdate;
    onUpdate(update: {
        sessionUpdate: string;
        [key: string]: unknown;
    }): void;
    /** Terminal: resolve every echo, close open blocks, report usage, finish. */
    settle(result: AcpPromptResult | undefined, error: Error | undefined): void;
}
export declare class AcpAdapter extends LlmAdapter {
    private readonly deps;
    private processes;
    private modelCache;
    private learnedContextWindow;
    /** In-flight sessions keyed by `${route}/${dshKey}` to survive stream calls. */
    private liveSessions;
    /** In-flight ACP turns keyed by liveKey; one ACP turn spans several DSH
     *  steps (several stream() calls) when tool calls are mirrored. */
    private activeTurns;
    /** Shared registry the display-only echo tools await their outcomes on. */
    private toolOutcomes;
    /** liveKeys whose display tools registered successfully. */
    private toolsReady;
    constructor(deps: AcpAdapterDeps);
    /** Register the display tools once per session; false forces text display. */
    private ensureDisplayTools;
    /** Detach a finished turn: notification listener, signal, scratch cleanup. */
    private closeActiveTurn;
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(): ResolvedRetryPolicy;
    private profileFor;
    private ensureProcess;
    /** Drop processes and cached state for routes no longer configured. */
    reconcileRoutes(): void;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * Discover per-model reasoning efforts. Agents disclose the thought-level
     * config option only for the session's CURRENT model (opencode: category
     * `thought_level` appears after selecting a reasoning-capable model), so
     * discovery walks every candidate on the scratch session, then restores the
     * initial selection. Models without the option simply get no entry.
     */
    private discoverEfforts;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    private establishSession;
    private persistSession;
    /** Locally answered auxiliary calls: never forwarded to the agent. */
    private auxiliary;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private toPromptBlocks;
    /** Stop every agent process (plugin dispose). */
    dispose(): void;
}
/**
 * Synthesize a session title locally. dsh-session-title-llm frames the
 * selected human messages as a JSON array inside one plugin-kind message
 * (`...human messages:\n[...]`); recover the first message's text from that
 * frame, falling back to the raw first text block for unframed callers.
 */
export declare function synthesizeTitle(messages: readonly Message[]): string;
