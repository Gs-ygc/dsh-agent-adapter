/**
 * Known ACP agents and local installation scanning. The known table ships in
 * both halves: the host scans PATH and owns route eligibility; the client
 * settings page renders the same identities from the state endpoint payload.
 *
 * @module dsh-agent-adapter/acp/agents
 */
import type { ResolvedProfile } from './config.js';
import { detectAgent, type AgentDetection } from '../detect.js';
/** One ACP agent the plugin knows how to launch. */
export interface KnownAcpAgent {
    /** Route / settings key. */
    id: string;
    displayName: string;
    command: string;
    args: string[];
}
/** Agents with a verified ACP-over-stdio mode. */
export declare const KNOWN_ACP_AGENTS: readonly KnownAcpAgent[];
/** Scan-derived default profile for one detected known agent. */
export declare function defaultProfile(agent: KnownAcpAgent): ResolvedProfile;
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
/** Minimal shape of one settings-page agent row for ordering purposes. */
export interface AgentStateRow {
    detected: boolean;
    configured: boolean;
    /** Lower sorts first within the same usability group; codex ships 0. */
    priority?: number;
}
/**
 * Settings-page row order: usable rows (detected locally, or explicitly
 * configured) first, then by half-assigned priority (codex before the ACP
 * agents), stable within ties.
 */
export declare function sortAgentRows<T extends AgentStateRow>(rows: readonly T[]): T[];
