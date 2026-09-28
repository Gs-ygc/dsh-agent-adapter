/**
 * ACP half of dsh-agent-adapter: ACP (Agent Client Protocol) adapter for the
 * DeepSeek Harness LLM seam. Each configured provider route spawns one
 * long-lived ACP agent process (e.g. `opencode acp`); DSH sessions bound to
 * that route hold their conversation inside the agent, making the agent
 * itself the session's conversation partner.
 *
 * Routes come from two sources: explicit `agent-adapter.acp.providers`
 * profiles, and the known-agent scan — locally installed ACP agents
 * (opencode, kimi, pi) are detected on PATH and enabled by default; the
 * settings page toggles them via `agent-adapter.acp.agents.<id>.enabled`.
 * Settings changes hot-swap the registered route set; removed routes dispose
 * their processes.
 *
 * The client half (settings page) reads detection + enablement through the
 * `/plugins/dsh-agent-adapter/state.json` web route and writes switches
 * through the ordinary settings mutation channel.
 *
 * @module dsh-agent-adapter/acp
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AcpAdapter } from './adapter.js';
import { effectiveRoutes, KNOWN_ACP_AGENTS, scanInstalledAgents, sortAgentRows } from './agents.js';
import { Config, resolveProfiles } from './config.js';
import { AcpSessionStore } from './store.js';
import { AGENT_ADAPTER_NS } from '../ns.js';
/** Client-half state endpoint, next to the bundle route (`/plugins/<id>/client.js`). */
const STATE_PATH = '/plugins/dsh-agent-adapter/state.json';
/** Default location of the durable DSH↔ACP session mapping. */
function defaultStateFile() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, 'llm-acp', 'sessions.json');
}
/** Configurable-provider directory entries for every declared route. */
function directoryEntries(profiles) {
    return [...profiles.entries()].map(([provider, profile]) => ({
        provider,
        displayName: profile.displayName ?? provider,
        settingsNs: AGENT_ADAPTER_NS,
        settingsPath: ['acp', 'providers', provider],
        declared: true,
    }));
}
export function applyAcp(ctx, config, extras) {
    let current = () => config;
    /** Per-session disposers for the registered display-only echo tools. */
    const toolDisposers = new Map();
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
            .catch((error) => ctx.logger.warn(`llm-acp: agent scan failed: ${error}`))
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
    const adapter = new AcpAdapter({
        profiles,
        readImage: async (ref) => {
            const attachments = ctx.get('attachments');
            if (!attachments)
                throw new Error('llm-acp: attachments service unavailable; cannot forward images');
            return attachments.readImage(ref);
        },
        // ACP sessions must be rooted in the DSH session's own workspace; falling
        // back to the harness process cwd would point the agent at the wrong repo.
        resolveSessionCwd: (dshSessionId) => {
            const sessions = ctx.get('sessions');
            return sessions?.get(dshSessionId)?.header.cwd;
        },
        // Permission asks follow the SESSION's own DSH permission knobs:
        // danger-full-access → allow_always (the user already granted full trust);
        // approval-never → deny (headless fail-closed); otherwise bridge the ask
        // into the session's approval card, inheriting the turn's abort signal.
        requestApproval: async (dshSessionId, details) => {
            const sessions = ctx.get('sessions');
            const session = sessions?.get(dshSessionId);
            if (!session)
                return 'deny';
            const projections = ctx.get('sessionProjections');
            const knobs = projections?.stateOf(session, 'permissions');
            if (knobs?.sandbox === 'danger-full-access')
                return 'allow_always';
            if ((knobs?.approval ?? 'ask') === 'never')
                return 'deny';
            const approval = ctx.get('approval');
            const agents = ctx.get('agents');
            const agent = agents?.get(dshSessionId);
            if (!approval || !agent)
                return 'deny';
            const outcome = await approval.request({
                agent,
                toolName: details.toolName,
                ...(details.reason ? { reason: details.reason } : {}),
                ...(details.signal ? { signal: details.signal } : {}),
            });
            return outcome === 'allowed-once' ? 'allow' : outcome === 'cancelled' ? 'cancel' : 'deny';
        },
        // Register the display-only ACP echo tools on the session's own agent
        // scope, so they shadow nothing globally and unwind with the agent.
        registerTools: (sessionId, definitions) => {
            const agents = ctx.get('agents');
            const tools = agents?.get(sessionId)?.ctx?.tools;
            if (!tools)
                throw new Error('llm-acp: agent tools registry unavailable');
            for (const dispose of toolDisposers.get(sessionId) ?? [])
                dispose();
            toolDisposers.set(sessionId, definitions.map((def) => tools.register(def)));
        },
        store: new AcpSessionStore(defaultStateFile(), (message) => ctx.logger.warn(message)),
        logger: (message) => ctx.logger.warn(message),
    });
    ctx.effect(() => () => {
        adapter.dispose();
        for (const disposers of toolDisposers.values())
            for (const dispose of disposers)
                dispose();
        toolDisposers.clear();
    });
    let directory;
    let directoryFacts;
    const ensureDirectory = () => {
        const entries = directoryEntries(profiles());
        if (JSON.stringify(entries) === JSON.stringify(directoryFacts))
            return;
        if (directory === undefined) {
            // Unlike llm-pi-ai there is no built-in catalog, so the first settings
            // hydration may still see zero profiles; registering an empty directory
            // throws INVALID_DIRECTORY. Defer until onChange supplies one.
            if (entries.length === 0) {
                directoryFacts = entries;
                return;
            }
        }
        // Registration publishes an adapters-updated event synchronously. Record
        // the candidate first so a listener that re-enters this function does not
        // try to register the same directory while the first call is still open.
        const previousFacts = directoryFacts;
        directoryFacts = entries;
        try {
            if (directory === undefined) {
                directory = ctx.llm.registerConfigurableProviders(entries);
            }
            else {
                // replace([]) is legal: commit() simply clears the held entries.
                directory.replace(entries);
            }
        }
        catch (error) {
            directoryFacts = previousFacts;
            throw error;
        }
    };
    let registration;
    let registeredRoutes;
    const ensureRegistration = () => {
        const routes = [...profiles().keys()].sort();
        if (JSON.stringify(routes) === JSON.stringify(registeredRoutes))
            return;
        if (registration === undefined) {
            if (routes.length === 0) {
                registeredRoutes = routes;
                return;
            }
        }
        // registerAdapter/replace also publish synchronously; close the same
        // re-entrancy window as the configurable-provider directory above.
        const previousRoutes = registeredRoutes;
        registeredRoutes = routes;
        try {
            if (registration === undefined) {
                registration = ctx.llm.registerAdapter(routes, adapter);
            }
            else {
                registration.replace(routes);
            }
        }
        catch (error) {
            registeredRoutes = previousRoutes;
            throw error;
        }
    };
    const onTopologyMaybeChanged = () => {
        try {
            adapter.reconcileRoutes();
            ensureRegistration();
        }
        catch (error) {
            ctx.logger.error('llm-acp: keeping the previously registered routes after a refused update');
            ctx.logger.error(error);
        }
        try {
            ensureDirectory();
        }
        catch (error) {
            ctx.logger.error('llm-acp: keeping the previous configurable-provider directory after a refused update');
            ctx.logger.error(error);
        }
    };
    // Client-half state: known agents with detection, version, and effective
    // enablement. Reads trigger a rescan so the page never renders stale probes.
    const stateHandler = async (_req, res) => {
        await rescan();
        const raw = current();
        const agents = KNOWN_ACP_AGENTS.map((agent, index) => ({
            ns: 'agent-adapter',
            id: agent.id,
            name: agent.displayName,
            command: [agent.command, ...agent.args].join(' '),
            detected: detections[agent.id]?.detected ?? false,
            ...(detections[agent.id]?.version ? { version: detections[agent.id].version } : {}),
            enabled: raw.agents?.[agent.id]?.enabled !== false,
            configured: raw.providers?.[agent.id] !== undefined,
            switchPath: ['acp', 'agents', agent.id, 'enabled'],
            // ACP agents sort after codex (priority 0) in the settings page.
            priority: 10 + index,
        }));
        const customs = Object.keys(raw.providers ?? {}).filter((id) => !KNOWN_ACP_AGENTS.some((a) => a.id === id));
        // Fold in the other half's state (e.g. the codex agent row) so a single
        // settings page covers every adapter this plugin bundles.
        const extraAgents = [];
        const extraCustoms = [];
        for (const contribution of extras?.contributions ?? []) {
            try {
                const result = await contribution();
                extraAgents.push(...(result.agents ?? []));
                extraCustoms.push(...(result.customs ?? []));
            }
            catch (error) {
                ctx.logger.warn(`llm-acp: extra state contribution failed: ${error}`);
            }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
        // Usable (detected/configured) rows first, codex ahead of the ACP agents.
        const rows = sortAgentRows([...agents, ...extraAgents]);
        res.end(JSON.stringify({ agents: rows, customs: [...customs, ...extraCustoms] }));
    };
    // webServer is optional (headless profiles do not provide it) and may appear
    // after this plugin. A child injection follows that service lifecycle and
    // registers the endpoint whenever the web host is available.
    ctx.inject(['webServer'], (webCtx) => {
        const webServer = webCtx.get('webServer');
        webCtx.effect(() => webServer.register({ kind: 'exact', path: STATE_PATH, handler: stateHandler }));
    });
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
    return { hooks };
}
export { Config, AcpAdapter };
