/**
 * Display-only DSH tool definitions mirroring codex's agent-side items
 * (commandExecution / fileChange / mcpToolCall / webSearch). The adapter emits
 * matching `tool-call` content blocks as codex items start; the agent loop
 * then "executes" these definitions, whose execute() only waits for the
 * pre-recorded codex outcome the adapter publishes — they never run anything
 * themselves. Their presentCall/presentResult render intents make the
 * generic tool card draw terminal / diff-style cards, exactly like DSH's own
 * bash/edit tools.
 */
import type { CallId, ContentBlock } from '@deepseek-ai/dsh-llm';
/** Outcome of one codex item, published by the adapter when the item settles. */
export interface CodexToolOutcome {
    status: string;
    /** commandExecution */
    output?: string;
    exitCode?: number | null;
    durationMs?: number;
    /** mcpToolCall */
    result?: unknown;
    error?: string;
    /** True when the codex turn had already completed when this outcome was
     *  published — the echo then concludes the DSH turn (no trailing LLM step). */
    final: boolean;
}
/** Minimal structural mirror of the dsh-tools contracts this file uses (the
 *  harness supplies the runtime; typing structurally avoids a hard dep). */
export interface DisplayToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: unknown): ContentBlock[];
        presentationMeta?(args: unknown, value: unknown): unknown;
    };
    execute(args: unknown, exec: {
        callId: CallId;
        signal: AbortSignal;
        concludeTurn(): void;
    }): Promise<unknown>;
    presentCall(args: unknown): Record<string, unknown> | undefined;
    presentResult(args: unknown, result: {
        content: ContentBlock[];
        isError: boolean;
        meta?: unknown;
    }): Record<string, unknown> | undefined;
    isConcurrencySafe(): boolean;
}
/** Registry of in-flight codex item outcomes, keyed by codex item id. */
export declare class CodexToolOutcomes {
    private pending;
    /** Register a pending outcome when the codex item starts. */
    begin(itemId: string): void;
    /** Publish the item's outcome; `final` marks turn-terminal results. */
    publish(itemId: string, outcome: Omit<CodexToolOutcome, 'final'> & {
        final?: boolean;
    }): void;
    /** Resolve every outstanding outcome (turn completed / interrupted). */
    publishAll(final: boolean, status: string): void;
    /** True when no outcome is pending for the item (e.g. replayed calls). */
    isPending(itemId: string): boolean;
    /** Wait for one item's outcome; resolves 'interrupted' on abort. */
    awaitOutcome(itemId: string, signal: AbortSignal): Promise<CodexToolOutcome>;
}
/**
 * Build the four display-only tool definitions. `outcomes` is shared with the
 * adapter; `concludeIfFinal` behavior is what lets the agent loop finish the
 * turn right after the last echo instead of running one more empty step.
 */
export declare function codexDisplayTools(outcomes: CodexToolOutcomes): DisplayToolDefinition[];
