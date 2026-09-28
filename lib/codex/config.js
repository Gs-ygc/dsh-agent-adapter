/**
 * Configuration schema and provider-profile resolution for the codex adapter.
 * Profiles are a dict keyed by provider route, so the composition base and a
 * user-settings layer merge per provider — the same shape as dsh-llm-pi-ai.
 *
 * @module dsh-agent-adapter/codex/config
 */
import z from '@deepseek-ai/schemastery';
/** Context size assumed for a model until codex reports the real one. */
export const DEFAULT_CONTEXT_WINDOW = 272_000;
/** Output cap assumed for a model; app-server has no per-request token control. */
export const DEFAULT_MAX_TOKENS = 32_768;
const profile = z.object({
    /** Human-readable provider name for selectors; defaults to the route key. */
    displayName: z.string(),
    /** codex executable, e.g. `codex`. */
    command: z.string().required(),
    /** Arguments, e.g. `["app-server", "--stdio"]`. */
    args: z.array(z.string()).default(['app-server', '--stdio']),
    /** Extra environment for the app-server process. */
    env: z.dict(z.string()),
    /** Working directory for the app-server process and new threads. */
    cwd: z.string(),
    /**
     * Optional codex approval policy override passed to thread/turn start
     * (`untrusted` | `on-failure` | `on-request` | `never`). Unset derives from
     * the DSH session's permission mode; `never` makes codex decide everything
     * itself (unattended operation, nothing reaches the DSH approval bridge).
     */
    approvalPolicy: z.string(),
    /**
     * Optional codex sandbox mode override (`read-only` | `workspace-write` |
     * `danger-full-access`); unset follows the DSH session's permission mode.
     */
    sandbox: z.string(),
    /** Context size reported to the harness until codex discloses one. */
    defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
    /** Output cap surfaced through resolveModel. */
    defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
});
/** Runtime schema for the plugin Config. */
export const Config = z.object({
    providers: z.dict(profile).default({}),
    /**
     * Enable switches for the auto-detected known codex agent, keyed by agent id
     * (`codex`). Absent entries default to enabled; the settings page writes
     * `false` here to hide a detected agent's routes.
     */
    agents: z.dict(z.object({ enabled: z.boolean().default(true) })).default({}),
});
/**
 * Validate and detach the raw providers dict into a route-keyed map.
 * An omitted dict resolves to the empty (dormant) route set.
 */
export function resolveProfiles(providers) {
    const resolved = new Map();
    if (!providers)
        return resolved;
    for (const [route, entry] of Object.entries(providers)) {
        if (!entry || typeof entry.command !== 'string' || entry.command.length === 0) {
            throw new Error(`llm-codex: provider "${route}" requires a non-empty "command"`);
        }
        resolved.set(route, {
            ...entry,
            args: entry.args ?? ['app-server', '--stdio'],
            defaultContextWindow: entry.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
            defaultMaxTokens: entry.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
        });
    }
    return resolved;
}
