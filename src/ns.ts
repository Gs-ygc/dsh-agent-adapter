/**
 * Shared settings namespace for dsh-agent-adapter: both halves
 * (codex and ACP) live under the single `agent-adapter` namespace, with their
 * slices at `agent-adapter.codex` / `agent-adapter.acp`.
 *
 * @module dsh-agent-adapter/ns
 */
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** The unified settings namespace owned by the combined plugin entry. */
export const AGENT_ADAPTER_NS = settingsNamespace('agent-adapter')

/**
 * The hooks a half exposes so the combined entry can wire it into the single
 * settings section (mirrors {@link installSettingsSection}'s consumer hooks).
 */
export interface SettingsHooks<T> {
  /** Point the half at a new resolved-config source thunk. */
  setSource: (source: () => T) => void
  /** Notify the half that its resolved slice may have changed. */
  onChange: () => void
}
