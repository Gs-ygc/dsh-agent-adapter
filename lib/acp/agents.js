import { detectAgent } from '../detect.js';
/** Agents with a verified ACP-over-stdio mode. */
export const KNOWN_ACP_AGENTS = [
    { id: 'opencode', displayName: 'OpenCode', command: 'opencode', args: ['acp'] },
    { id: 'kimi', displayName: 'Kimi Code CLI', command: 'kimi', args: ['acp'] },
    { id: 'pi', displayName: 'Pi', command: 'pi-acp', args: [] },
];
/** Scan-derived default profile for one detected known agent. */
export function defaultProfile(agent) {
    return {
        displayName: agent.displayName,
        command: agent.command,
        args: agent.args,
        permissionPolicy: 'auto',
        defaultContextWindow: 200_000,
        defaultMaxTokens: 32_768,
    };
}
/**
 * Effective route set from explicit providers, the known-agent enable switches,
 * and detection results. Known agents are gated by their switch regardless of
 * whether the profile came from the scan or an explicit same-id override;
 * custom routes are always enabled (written deliberately).
 */
export function effectiveRoutes(providers, agentsConfig, detections) {
    const knownIds = new Set(KNOWN_ACP_AGENTS.map((a) => a.id));
    const next = new Map();
    for (const agent of KNOWN_ACP_AGENTS) {
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
    const entries = await Promise.all(KNOWN_ACP_AGENTS.map(async (agent) => [agent.id, await detectAgent(agent.command)]));
    return Object.fromEntries(entries);
}
// Re-export the shared detection primitives for backward compatibility with
// callers that imported them from this module before the extraction.
export { detectAgent };
/**
 * Settings-page row order: usable rows (detected locally, or explicitly
 * configured) first, then by half-assigned priority (codex before the ACP
 * agents), stable within ties.
 */
export function sortAgentRows(rows) {
    return [...rows].sort((a, b) => {
        const usableA = a.detected || a.configured;
        const usableB = b.detected || b.configured;
        if (usableA !== usableB)
            return usableA ? -1 : 1;
        return (a.priority ?? 100) - (b.priority ?? 100);
    });
}
