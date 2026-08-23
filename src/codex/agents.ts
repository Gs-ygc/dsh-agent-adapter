/**
 * Known codex agents and local installation scanning — mirrors the ACP half's
 * known-agent mechanism. The known table ships in both halves: the host scans
 * PATH and owns route eligibility; the client settings page renders the same
 * identities from the state endpoint payload.
 *
 * @module dsh-agent-adapter/codex/agents
 */
import type { ResolvedProfile } from './config.js'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './config.js'
import { detectAgent, type AgentDetection } from '../detect.js'

/** One codex agent the plugin knows how to launch. */
export interface KnownCodexAgent {
  /** Route / settings key. */
  id: string
  displayName: string
  command: string
  args: string[]
}

/** Agents with a verified app-server-over-stdio mode. */
export const KNOWN_CODEX_AGENTS: readonly KnownCodexAgent[] = [
  { id: 'codex', displayName: 'Codex', command: 'codex', args: ['app-server', '--stdio'] },
]

/** Scan-derived default profile for one detected known agent. */
export function defaultProfile(agent: KnownCodexAgent): ResolvedProfile {
  return {
    displayName: agent.displayName,
    command: agent.command,
    args: agent.args,
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
  }
}

/**
 * Effective route set from explicit providers, the known-agent enable switches,
 * and detection results. Known agents are gated by their switch regardless of
 * whether the profile came from the scan or an explicit same-id override;
 * custom routes are always enabled (written deliberately).
 */
export function effectiveRoutes(
  providers: Map<string, ResolvedProfile>,
  agentsConfig: Record<string, { enabled?: boolean }> | undefined,
  detections: Record<string, AgentDetection>,
): Map<string, ResolvedProfile> {
  const knownIds = new Set(KNOWN_CODEX_AGENTS.map((a) => a.id))
  const next = new Map<string, ResolvedProfile>()
  for (const agent of KNOWN_CODEX_AGENTS) {
    if (agentsConfig?.[agent.id]?.enabled === false) continue
    const override = providers.get(agent.id)
    if (override) next.set(agent.id, override)
    else if (detections[agent.id]?.detected) next.set(agent.id, defaultProfile(agent))
  }
  for (const [route, profile] of providers) {
    if (!knownIds.has(route)) next.set(route, profile)
  }
  return next
}

/** Probe every known agent in parallel. */
export async function scanInstalledAgents(): Promise<Record<string, AgentDetection>> {
  const entries = await Promise.all(
    KNOWN_CODEX_AGENTS.map(async (agent) => [agent.id, await detectAgent(agent.command)] as const),
  )
  return Object.fromEntries(entries)
}

// Re-export the shared detection primitives so the codex half exposes the same
// probe surface the ACP half does.
export { detectAgent, type AgentDetection }
