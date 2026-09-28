/**
 * Configuration schema and provider-profile resolution for the ACP adapter.
 * Profiles are a dict keyed by provider route, so the composition base and a
 * user-settings layer merge per provider — the same shape as dsh-llm-pi-ai.
 *
 * @module dsh-agent-adapter/acp/config
 */
import z from '@deepseek-ai/schemastery';
/** Context size assumed for a model until a `usage_update` reports the real one. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Output cap assumed for a model; ACP has no per-request token control. */
export const DEFAULT_MAX_TOKENS = 32_768;
const profile = z.object({
    /** Human-readable provider name for selectors; defaults to the route key. */
    displayName: z.string(),
    /** ACP agent executable, e.g. `opencode`. */
    command: z.string().required(),
    /** Arguments, e.g. `["acp"]`. */
    args: z.array(z.string()).default([]),
    /** Extra environment for the agent process. */
    env: z.dict(z.string()),
    /** Working directory for the agent process and new ACP sessions. */
    cwd: z.string(),
    /** Permission answers: auto derives from the session's DSH permission knobs (danger-full-access → allow_always, approval-never → deny, else bridge to the approval UI); allow/deny are fixed overrides. */
    permissionPolicy: z.union(['auto', 'allow', 'deny']).default('auto'),
    /** Context size reported to the harness until the agent discloses one. */
    defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
    /** Output cap surfaced through resolveModel. */
    defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
});
/** Runtime schema for the plugin Config. */
export const Config = z.object({
    providers: z.dict(profile).default({}),
    /**
     * Enable switches for the auto-detected known agents, keyed by agent id
     * (`opencode`, `kimi`, `pi`, …). Absent entries default to enabled; the
     * settings page writes `false` here to hide a detected agent's routes.
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
            throw new Error(`llm-acp: provider "${route}" requires a non-empty "command"`);
        }
        resolved.set(route, {
            ...entry,
            args: entry.args ?? [],
            permissionPolicy: entry.permissionPolicy ?? 'auto',
            defaultContextWindow: entry.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
            defaultMaxTokens: entry.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
        });
    }
    return resolved;
}
