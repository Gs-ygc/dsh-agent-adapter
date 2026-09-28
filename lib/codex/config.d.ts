/**
 * Configuration schema and provider-profile resolution for the codex adapter.
 * Profiles are a dict keyed by provider route, so the composition base and a
 * user-settings layer merge per provider — the same shape as dsh-llm-pi-ai.
 *
 * @module dsh-agent-adapter/codex/config
 */
import z from '@deepseek-ai/schemastery';
/** Context size assumed for a model until codex reports the real one. */
export declare const DEFAULT_CONTEXT_WINDOW = 272000;
/** Output cap assumed for a model; app-server has no per-request token control. */
export declare const DEFAULT_MAX_TOKENS = 32768;
/** Runtime schema for the plugin Config. */
export declare const Config: z<Schemastery.ObjectS<{
    providers: z<import("@deepseek-ai/cosmokit").Dict<{
        displayName?: string | null | undefined;
        command?: string | null | undefined;
        args?: string[] | null | undefined;
        env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
        cwd?: string | null | undefined;
        approvalPolicy?: string | null | undefined;
        sandbox?: string | null | undefined;
        defaultContextWindow?: number | null | undefined;
        defaultMaxTokens?: number | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        /** Human-readable provider name for selectors; defaults to the route key. */
        displayName: z<string, string>;
        /** codex executable, e.g. `codex`. */
        command: z<string, string>;
        /** Arguments, e.g. `["app-server", "--stdio"]`. */
        args: z<string[], string[]>;
        /** Extra environment for the app-server process. */
        env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
        /** Working directory for the app-server process and new threads. */
        cwd: z<string, string>;
        /**
         * Optional codex approval policy override passed to thread/turn start
         * (`untrusted` | `on-failure` | `on-request` | `never`). Unset derives from
         * the DSH session's permission mode; `never` makes codex decide everything
         * itself (unattended operation, nothing reaches the DSH approval bridge).
         */
        approvalPolicy: z<string, string>;
        /**
         * Optional codex sandbox mode override (`read-only` | `workspace-write` |
         * `danger-full-access`); unset follows the DSH session's permission mode.
         */
        sandbox: z<string, string>;
        /** Context size reported to the harness until codex discloses one. */
        defaultContextWindow: z<number, number>;
        /** Output cap surfaced through resolveModel. */
        defaultMaxTokens: z<number, number>;
    }>, string>>;
    /**
     * Enable switches for the auto-detected known codex agent, keyed by agent id
     * (`codex`). Absent entries default to enabled; the settings page writes
     * `false` here to hide a detected agent's routes.
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
        approvalPolicy?: string | null | undefined;
        sandbox?: string | null | undefined;
        defaultContextWindow?: number | null | undefined;
        defaultMaxTokens?: number | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        /** Human-readable provider name for selectors; defaults to the route key. */
        displayName: z<string, string>;
        /** codex executable, e.g. `codex`. */
        command: z<string, string>;
        /** Arguments, e.g. `["app-server", "--stdio"]`. */
        args: z<string[], string[]>;
        /** Extra environment for the app-server process. */
        env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
        /** Working directory for the app-server process and new threads. */
        cwd: z<string, string>;
        /**
         * Optional codex approval policy override passed to thread/turn start
         * (`untrusted` | `on-failure` | `on-request` | `never`). Unset derives from
         * the DSH session's permission mode; `never` makes codex decide everything
         * itself (unattended operation, nothing reaches the DSH approval bridge).
         */
        approvalPolicy: z<string, string>;
        /**
         * Optional codex sandbox mode override (`read-only` | `workspace-write` |
         * `danger-full-access`); unset follows the DSH session's permission mode.
         */
        sandbox: z<string, string>;
        /** Context size reported to the harness until codex discloses one. */
        defaultContextWindow: z<number, number>;
        /** Output cap surfaced through resolveModel. */
        defaultMaxTokens: z<number, number>;
    }>, string>>;
    /**
     * Enable switches for the auto-detected known codex agent, keyed by agent id
     * (`codex`). Absent entries default to enabled; the settings page writes
     * `false` here to hide a detected agent's routes.
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
    approvalPolicy?: string;
    sandbox?: string;
    defaultContextWindow: number;
    defaultMaxTokens: number;
}
/**
 * Validate and detach the raw providers dict into a route-keyed map.
 * An omitted dict resolves to the empty (dormant) route set.
 */
export declare function resolveProfiles(providers: Record<string, ResolvedProfile> | undefined): Map<string, ResolvedProfile>;
