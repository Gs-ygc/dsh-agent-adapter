/**
 * Known codex agents and local installation scanning — mirrors the ACP half's
 * known-agent mechanism. The known table ships in both halves: the host scans
 * PATH and owns route eligibility; the client settings page renders the same
 * identities from the state endpoint payload.
 *
 * @module dsh-agent-adapter/codex/agents
 */
import type { ResolvedProfile } from './config.js';
import { detectAgent, type AgentDetection } from '../detect.js';
/** One codex agent the plugin knows how to launch. */
export interface KnownCodexAgent {
    /** Route / settings key. */
    id: string;
    displayName: string;
    command: string;
    args: string[];
}
/** Agents with a verified app-server-over-stdio mode. */
export declare const KNOWN_CODEX_AGENTS: readonly KnownCodexAgent[];
/** Scan-derived default profile for one detected known agent. */
export declare function defaultProfile(agent: KnownCodexAgent): ResolvedProfile;
/**
 * Effective route set from explicit providers, the known-agent enable switches,
 * and detection results. Known agents are gated by their switch regardless of
 * whether the profile came from the scan or an explicit same-id override;
 * custom routes are always enabled (written deliberately).
 */
export declare function effectiveRoutes(providers: Map<string, ResolvedProfile>, agentsConfig: Record<string, {
    enabled?: boolean;
}> | undefined, detections: Record<string, AgentDetection>): Map<string, ResolvedProfile>;
/** Probe every known agent in parallel. */
export declare function scanInstalledAgents(): Promise<Record<string, AgentDetection>>;
export { detectAgent, type AgentDetection };
