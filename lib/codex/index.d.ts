import type { Context } from '@deepseek-ai/cordis';
import { CodexAdapter } from './adapter.js';
import { Config, type ResolvedProfile } from './config.js';
import { type SettingsHooks } from '../ns.js';
/** Config accepted by applyCodex; the codex slice of the combined plugin. */
export interface RawConfig {
    providers?: Record<string, ResolvedProfile>;
    agents?: Record<string, {
        enabled?: boolean;
    }>;
}
/** One codex agent row folded into the settings page's scan payload. */
export interface CodexAgentRow {
    ns: 'agent-adapter';
    id: string;
    name: string;
    command: string;
    detected: boolean;
    version?: string;
    enabled: boolean;
    configured: boolean;
    /** Full settings path of this row's enable switch within the namespace. */
    switchPath: string[];
    /** Settings-page order: codex leads the usable group (ACP rows start at 10). */
    priority: number;
}
export declare function applyCodex(ctx: Context, config: RawConfig): {
    contribution: () => Promise<{
        agents: CodexAgentRow[];
        customs: string[];
    }>;
    hooks: SettingsHooks<RawConfig>;
};
export { Config, CodexAdapter };
