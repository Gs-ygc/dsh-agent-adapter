/**
 * Configuration schema and provider-profile resolution for the ACP adapter.
 * Profiles are a dict keyed by provider route, so the composition base and a
 * user-settings layer merge per provider — the same shape as dsh-llm-pi-ai.
 *
 * @module dsh-agent-adapter/acp/config
 */
import z from '@deepseek-ai/schemastery';
/** Context size assumed for a model until a `usage_update` reports the real one. */
export declare const DEFAULT_CONTEXT_WINDOW = 200000;
/** Output cap assumed for a model; ACP has no per-request token control. */
export declare const DEFAULT_MAX_TOKENS = 32768;
/** Runtime schema for the plugin Config. */
export declare const Config: z<Schemastery.ObjectS<{
    providers: z<import("@deepseek-ai/cosmokit").Dict<{
        displayName?: string | null | undefined;
        command?: string | null | undefined;
        args?: string[] | null | undefined;
        env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
        cwd?: string | null | undefined;
        permissionPolicy?: "allow" | "deny" | "auto" | null | undefined;
        defaultContextWindow?: number | null | undefined;
        defaultMaxTokens?: number | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        /** Human-readable provider name for selectors; defaults to the route key. */
        displayName: z<string, string>;
        /** ACP agent executable, e.g. `opencode`. */
        command: z<string, string>;
        /** Arguments, e.g. `["acp"]`. */
        args: z<string[], string[]>;
        /** Extra environment for the agent process. */
        env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
        /** Working directory for the agent process and new ACP sessions. */
        cwd: z<string, string>;
        /** Permission answers: auto derives from the session's DSH permission knobs (danger-full-access → allow_always, approval-never → deny, else bridge to the approval UI); allow/deny are fixed overrides. */
        permissionPolicy: z<"allow" | "deny" | "auto", "allow" | "deny" | "auto">;
        /** Context size reported to the harness until the agent discloses one. */
        defaultContextWindow: z<number, number>;
        /** Output cap surfaced through resolveModel. */
        defaultMaxTokens: z<number, number>;
    }>, string>>;
    /**
     * Enable switches for the auto-detected known agents, keyed by agent id
     * (`opencode`, `kimi`, `pi`, …). Absent entries default to enabled; the
     * settings page writes `false` here to hide a detected agent's routes.
     */
    agents: z<import("@deepseek-ai/cosmokit").Dict<{
        enabled?: boolean | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
    }>, string>>;
}>, Schemastery.ObjectT<{
    providers: z<import("@deepseek-ai/cosmokit").Dict<{
        displayName?: string | null | undefined;
        command?: string | null | undefined;
        args?: string[] | null | undefined;
        env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
        cwd?: string | null | undefined;
        permissionPolicy?: "allow" | "deny" | "auto" | null | undefined;
        defaultContextWindow?: number | null | undefined;
        defaultMaxTokens?: number | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        /** Human-readable provider name for selectors; defaults to the route key. */
        displayName: z<string, string>;
        /** ACP agent executable, e.g. `opencode`. */
        command: z<string, string>;
        /** Arguments, e.g. `["acp"]`. */
        args: z<string[], string[]>;
        /** Extra environment for the agent process. */
        env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
        /** Working directory for the agent process and new ACP sessions. */
        cwd: z<string, string>;
        /** Permission answers: auto derives from the session's DSH permission knobs (danger-full-access → allow_always, approval-never → deny, else bridge to the approval UI); allow/deny are fixed overrides. */
        permissionPolicy: z<"allow" | "deny" | "auto", "allow" | "deny" | "auto">;
        /** Context size reported to the harness until the agent discloses one. */
        defaultContextWindow: z<number, number>;
        /** Output cap surfaced through resolveModel. */
        defaultMaxTokens: z<number, number>;
    }>, string>>;
    /**
     * Enable switches for the auto-detected known agents, keyed by agent id
     * (`opencode`, `kimi`, `pi`, …). Absent entries default to enabled; the
     * settings page writes `false` here to hide a detected agent's routes.
     */
    agents: z<import("@deepseek-ai/cosmokit").Dict<{
        enabled?: boolean | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
    }>, string>>;
}>>;
/** One validated provider profile keyed by its route. */
export interface ResolvedProfile {
    displayName?: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
    permissionPolicy: 'auto' | 'allow' | 'deny';
    defaultContextWindow: number;
    defaultMaxTokens: number;
}
/**
 * Validate and detach the raw providers dict into a route-keyed map.
 * An omitted dict resolves to the empty (dormant) route set.
 */
export declare function resolveProfiles(providers: Record<string, ResolvedProfile> | undefined): Map<string, ResolvedProfile>;
