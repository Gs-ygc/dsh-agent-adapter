/**
 * Shared settings namespace for dsh-agent-adapter: both halves
 * (codex and ACP) live under the single `agent-adapter` namespace, with their
 * slices at `agent-adapter.codex` / `agent-adapter.acp`.
 *
 * @module dsh-agent-adapter/ns
 */

/** The unified settings namespace owned by the combined plugin entry. */
export const AGENT_ADAPTER_NS = 'agent-adapter';
