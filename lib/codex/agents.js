import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './config.js';
import { detectAgent } from '../detect.js';
/** Agents with a verified app-server-over-stdio mode. */
export const KNOWN_CODEX_AGENTS = [
    { id: 'codex', displayName: 'Codex', command: 'codex', args: ['app-server', '--stdio'] },
];
/** Scan-derived default profile for one detected known agent. */
export function defaultProfile(agent) {
    return {
        displayName: agent.displayName,
        command: agent.command,
        args: agent.args,
        defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
        defaultMaxTokens: DEFAULT_MAX_TOKENS,
    };
}
/**
 * Effective route set from explicit providers, the known-agent enable switches,
 * and detection results. Known agents are gated by their switch regardless of
 * whether the profile came from the scan or an explicit same-id override;
 * custom routes are always enabled (written deliberately).
 */
export function effectiveRoutes(providers, agentsConfig, detections) {
    const knownIds = new Set(KNOWN_CODEX_AGENTS.map((a) => a.id));
    const next = new Map();
    for (const agent of KNOWN_CODEX_AGENTS) {
        if (agentsConfig?.[agent.id]?.enabled === false)
            continue;
        const override = providers.get(agent.id);
        if (override)
            next.set(agent.id, override);
        else if (detections[agent.id]?.detected)
            next.set(agent.id, defaultProfile(agent));
    }
    for (const [route, profile] of providers) {
        if (!knownIds.has(route))
            next.set(route, profile);
    }
    return next;
}
/** Probe every known agent in parallel. */
export async function scanInstalledAgents() {
    const entries = await Promise.all(KNOWN_CODEX_AGENTS.map(async (agent) => [agent.id, await detectAgent(agent.command)]));
    return Object.fromEntries(entries);
}
// Re-export the shared detection primitives so the codex half exposes the same
// probe surface the ACP half does.
export { detectAgent };
