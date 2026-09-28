/**
 * codex half of dsh-agent-adapter: codex app-server adapter for the DeepSeek
 * Harness LLM seam. Each configured provider route spawns one long-lived
 * `codex app-server` process; DSH sessions bound to that route hold their
 * conversation inside a codex thread, making codex itself the session's
 * conversation partner.
 *
 * Routes come from two sources: explicit `agent-adapter.codex.providers`
 * profiles, and the known-agent scan — a locally installed `codex` is
 * detected on PATH and enabled by default; the settings page toggles it via
 * `agent-adapter.codex.agents.codex.enabled`. Settings changes hot-swap the
 * registered route set; removed routes dispose their processes.
 *
 * The client half (settings page) reads detection + enablement through the
 * `/plugins/dsh-agent-adapter/state.json` web route served by the ACP half,
 * which folds this half's `contribution()` state into the payload.
 *
 * @module dsh-agent-adapter/codex
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CodexAdapter } from './adapter.js';
import { effectiveRoutes, KNOWN_CODEX_AGENTS, scanInstalledAgents } from './agents.js';
import { Config, resolveProfiles } from './config.js';
import { CodexSessionStore } from './store.js';
import { AGENT_ADAPTER_NS } from '../ns.js';
/** Default location of the durable DSH↔codex thread mapping. */
function defaultStateFile() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, 'llm-codex', 'sessions.json');
}
/** Read a host-plane service not declared on the cordis Context type. */
function hostGet(ctx, key) {
    return ctx.get(key);
}
/** Configurable-provider directory entries for every declared route. */
function directoryEntries(profiles) {
    return [...profiles.entries()].map(([provider, profile]) => ({
        provider,
        displayName: profile.displayName ?? provider,
        settingsNs: AGENT_ADAPTER_NS,
        settingsPath: ['codex', 'providers', provider],
        declared: true,
    }));
}
export function applyCodex(ctx, config) {
    let current = () => config;
    // Detection state: seeded at apply, refreshed on settings change and on
    // state-endpoint reads, so the settings page always sees a fresh scan.
    let detections = {};
    let scanning;
    const rescan = () => {
        scanning ??= scanInstalledAgents()
            .then((found) => {
            detections = found;
            onTopologyMaybeChanged();
        })
            .catch((error) => ctx.logger.warn(`llm-codex: agent scan failed: ${error}`))
            .finally(() => { scanning = undefined; });
        return scanning;
    };
    let lastRaw;
    let memoized;
    const profiles = () => {
        const raw = current();
        const key = `${JSON.stringify(raw)}|${JSON.stringify(detections)}`;
        if (key === lastRaw && memoized !== undefined)
            return memoized;
        const explicit = resolveProfiles(raw.providers);
        const next = effectiveRoutes(explicit, raw.agents, detections);
        lastRaw = key;
        memoized = next;
        return next;
    };
    profiles();
    // Per-session disposers for the display-only codex tool registrations, so
    // a re-registration (plugin reload over a live agent) replaces the stale
    // definitions that close over the previous adapter's outcome registry.
    const toolDisposers = new Map();
    ctx.effect(() => () => {
        for (const disposers of toolDisposers.values())
            for (const dispose of disposers)
                dispose();
        toolDisposers.clear();
    });
    const adapter = new CodexAdapter({
        profiles,
        readImage: async (ref) => {
            const attachments = ctx.get('attachments');
            if (!attachments)
                throw new Error('llm-codex: attachments service unavailable; cannot forward images');
            return attachments.readImage(ref);
        },
        // The sessions service is host-plane but not declared on the cordis
        // Context type; read it defensively and only trust an absolute cwd.
        sessionCwd: (sessionId) => {
            const sessions = hostGet(ctx, 'sessions');
            const cwd = sessions?.get(sessionId)?.header?.cwd;
            return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : undefined;
        },
        // The session's effective sandbox mode: the logged override wins, then the
        // deployment default.
        sessionPermission: (sessionId) => {
            const sessions = hostGet(ctx, 'sessions');
            const sandboxPolicy = hostGet(ctx, 'sandboxPolicy');
            if (!sandboxPolicy)
                return undefined;
            const session = sessions?.get(sessionId);
            const mode = (session ? sandboxPolicy.overrideOf(session) : undefined) ?? sandboxPolicy.defaultMode;
            return typeof mode === 'string' ? mode : undefined;
        },
        // Bridge codex approval prompts into the DSH approval service. The
        // request requires an open turn — codex only asks mid-turn, while the
        // harness stream call (and its step) is running.
        requestApproval: async ({ sessionId, kind, command, reason, signal }) => {
            const approval = hostGet(ctx, 'approval');
            const agents = hostGet(ctx, 'agents');
            const agent = agents?.get(sessionId);
            if (!approval || !agent)
                return undefined; // fail closed
            const toolName = kind === 'command'
                ? 'codex (shell command)'
                : kind === 'fileChange'
                    ? 'codex (file change)'
                    : 'codex (permission request)';
            const why = [command, reason].filter(Boolean).join('\n') || undefined;
            try {
                const outcome = await approval.request({ agent, toolName, ...(why ? { reason: why } : {}), ...(signal ? { signal } : {}) });
                if (outcome === 'allowed-once')
                    return 'accept';
                if (outcome === 'rejected')
                    return 'decline';
                return 'cancel'; // cancelled | unavailable
            }
            catch {
                return undefined; // fail closed
            }
        },
        // Register the display-only codex tools on the session's own agent scope,
        // so they shadow nothing globally and unwind with the agent.
        registerTools: (sessionId, definitions) => {
            const agents = hostGet(ctx, 'agents');
            const tools = agents?.get(sessionId)?.ctx?.tools;
            if (!tools)
                throw new Error('llm-codex: agent tools registry unavailable');
            for (const dispose of toolDisposers.get(sessionId) ?? [])
                dispose();
            toolDisposers.set(sessionId, definitions.map((def) => tools.register(def)));
        },
        store: new CodexSessionStore(defaultStateFile(), (message) => ctx.logger.warn(message)),
        logger: (message) => ctx.logger.warn(message),
    });
    ctx.effect(() => () => adapter.dispose());
    let directory;
    let directoryFacts;
    const ensureDirectory = () => {
        const entries = directoryEntries(profiles());
        if (JSON.stringify(entries) === JSON.stringify(directoryFacts))
            return;
        if (directory === undefined) {
            // There is no built-in catalog, so the first settings hydration may
            // still see zero profiles; registering an empty directory throws
            // INVALID_DIRECTORY. Defer until onChange supplies one.
            if (entries.length === 0) {
                directoryFacts = entries;
                return;
            }
            directory = ctx.llm.registerConfigurableProviders(entries);
        }
        else {
            // replace([]) is legal: commit() simply clears the held entries.
            directory.replace(entries);
        }
        directoryFacts = entries;
    };
    let registration;
    let registeredRoutes;
    const ensureRegistration = () => {
        const routes = [...profiles().keys()].sort();
        if (deepEqualJson(routes, registeredRoutes))
            return;
        if (registration === undefined) {
            if (routes.length === 0) {
                registeredRoutes = routes;
                return;
            }
            registration = ctx.llm.registerAdapter(routes, adapter);
        }
        else {
            registration.replace(routes);
        }
        registeredRoutes = routes;
    };
    const onTopologyMaybeChanged = () => {
        try {
            adapter.reconcileRoutes();
            ensureRegistration();
        }
        catch (error) {
            ctx.logger.error('llm-codex: keeping the previously registered routes after a refused update');
            ctx.logger.error(error);
        }
        try {
            ensureDirectory();
        }
        catch (error) {
            ctx.logger.error('llm-codex: keeping the previous configurable-provider directory after a refused update');
            ctx.logger.error(error);
        }
    };
    // State contribution folded into the ACP half's settings-page payload: the
    // known codex agent with detection, version, and effective enablement.
    // Reads trigger a rescan so the page never renders a stale probe.
    const contribution = async () => {
        await rescan();
        const raw = current();
        const agents = KNOWN_CODEX_AGENTS.map((agent) => ({
            ns: 'agent-adapter',
            id: agent.id,
            name: agent.displayName,
            command: [agent.command, ...agent.args].join(' '),
            detected: detections[agent.id]?.detected ?? false,
            ...(detections[agent.id]?.version ? { version: detections[agent.id].version } : {}),
            enabled: raw.agents?.[agent.id]?.enabled !== false,
            configured: raw.providers?.[agent.id] !== undefined,
            switchPath: ['codex', 'agents', agent.id, 'enabled'],
            priority: 0,
        }));
        const customs = Object.keys(raw.providers ?? {}).filter((id) => !KNOWN_CODEX_AGENTS.some((a) => a.id === id));
        return { agents, customs };
    };
    // rescan() applies the resulting topology itself.
    void rescan();
    // The combined entry wires these hooks into the single `agent-adapter`
    // settings section. Without a settings service they never fire and this
    // half keeps its composition slice (`current` stays the entry config).
    const hooks = {
        setSource: (source) => {
            current = source;
        },
        onChange: () => {
            // Enable switches may hide routes without a rescan; command overrides
            // may change what should be detected. Do both.
            onTopologyMaybeChanged();
            void rescan();
        },
    };
    return { contribution, hooks };
}
export { Config, CodexAdapter };
