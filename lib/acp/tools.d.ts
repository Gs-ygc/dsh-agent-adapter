/**
 * Display-only DSH tool definitions mirroring the ACP agent's own tool calls.
 * The adapter emits matching `tool-call` content blocks as ACP `tool_call`
 * updates arrive; the agent loop then "executes" these definitions, whose
 * execute() only waits for the pre-recorded ACP outcome the adapter publishes
 * — they never run anything themselves. Their presentCall/presentResult render
 * intents make the generic tool card draw terminal / edit-style cards, exactly
 * like DSH's own bash/edit tools.
 *
 * @module dsh-agent-adapter/acp/tools
 */
import type { CallId, ContentBlock } from '@deepseek-ai/dsh-llm';
/** Outcome of one ACP tool call, published by the adapter when it settles. */
export interface AcpToolOutcome {
    status: string;
    /** Aggregated text output from `tool_call_update` content entries. */
    output?: string;
    /** Terminal exit code from `rawOutput.metadata.exit`. */
    exitCode?: number;
    /** True when the ACP turn had already completed when this outcome was
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
/** Registry of in-flight ACP tool-call outcomes, keyed by ACP toolCallId. */
export declare class AcpToolOutcomes {
    private pending;
    /** Register a pending outcome when the tool-call block is emitted. */
    begin(toolCallId: string): void;
    /** Publish the call's outcome; `final` marks turn-terminal results. */
    publish(toolCallId: string, outcome: Omit<AcpToolOutcome, 'final'> & {
        final?: boolean;
    }): void;
    /** Resolve every outstanding outcome (plugin teardown). */
    publishAll(status: string): void;
    /** Wait for one call's outcome; resolves 'interrupted' on abort. */
    awaitOutcome(toolCallId: string, signal: AbortSignal): Promise<AcpToolOutcome>;
}
/**
 * Build the three display-only tool definitions. `outcomes` is shared with the
 * adapter; the `concludeTurn` behavior is what lets the agent loop finish the
 * turn right after the last echo instead of running one more empty step.
 */
export declare function acpDisplayTools(outcomes: AcpToolOutcomes): DisplayToolDefinition[];
