import type { Context } from '@deepseek-ai/cordis';
import { AcpAdapter } from './adapter.js';
import { Config, type ResolvedProfile } from './config.js';
import { type SettingsHooks } from '../ns.js';
export interface RawConfig {
    providers?: Record<string, ResolvedProfile>;
    agents?: Record<string, {
        enabled?: boolean;
    }>;
}
export declare function applyAcp(ctx: Context, config: RawConfig, extras?: {
    contributions?: Array<() => Promise<{
        agents: unknown[];
        customs: string[];
    }>>;
}): {
    hooks: SettingsHooks<RawConfig>;
};
export { Config, AcpAdapter };
