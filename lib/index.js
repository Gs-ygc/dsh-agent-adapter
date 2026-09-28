/**
 * dsh-agent-adapter: merged host-plane plugin bundling the two external-agent
 * adapters for the DeepSeek Harness LLM seam:
 *
 * - codex half (`./codex`): serves routes backed by `codex app-server`
 *   processes, settings slice `agent-adapter.codex`, state in
 *   `$DSH_HOME/llm-codex/sessions.json`.
 * - ACP half (`./acp`): serves routes backed by ACP agent processes (opencode,
 *   kimi, pi, …), settings slice `agent-adapter.acp`, state in
 *   `$DSH_HOME/llm-acp/sessions.json`, plus the client settings page served
 *   from `/plugins/dsh-agent-adapter/client.js` with its state endpoint at
 *   `/plugins/dsh-agent-adapter/state.json`.
 *
 * Both halves share the single `agent-adapter` settings namespace
 * (this module's Config is its schema; the halves expose hooks instead of
 * self-registering). State files are unchanged. Each half mounts dormant
 * until its settings slice supplies provider profiles (or its known-agent
 * scan detects an installed agent); settings changes hot-swap the registered
 * route set. The single settings page («Agent 适配 / Agent Adapter») covers
 * both halves: the ACP half owns the web state endpoint and folds in the codex
 * half's known-agent row via a state contribution.
 *
 * @module dsh-agent-adapter
 */
import z from '@deepseek-ai/schemastery';
import { Config as CodexConfig, CodexAdapter, applyCodex } from './codex/index.js';
import { Config as AcpConfig, AcpAdapter, applyAcp } from './acp/index.js';
import { AGENT_ADAPTER_NS } from './ns.js';
const name = 'agent-adapter';
const inject = ['llm'];
const NS = AGENT_ADAPTER_NS;
/**
 * Combined runtime schema — also the schema of the single `agent-adapter`
 * settings namespace. The two halves keep independent slices (`codex:` /
 * `acp:`); plugin-level keys simply seed each half's base config.
 */
export const Config = z.object({
    codex: CodexConfig.default({ providers: {}, agents: {} }),
    acp: AcpConfig.default({ providers: {}, agents: {} }),
});
export function apply(ctx, config) {
    // Halves start from their composition slices; when a settings service is
    // present the section below repoints them at the resolved `agent-adapter`
    // scope and hot-swaps routes on change.
    const codex = applyCodex(ctx, config.codex ?? {});
    const acp = applyAcp(ctx, config.acp ?? {}, { contributions: [codex.contribution] });
    // installSettingsSection inlined: the npm dsh-settings (0.1.7+) does not
    // ship this Homebrew-only helper, so the fork implements the same
    // register/watch/unload-fallback wiring directly against the service.
    ctx.inject(["settings"], (sctx) => {
        const scope = sctx.settings.register(NS, Config, { base: Config(config ?? {}) });
        const hooks = {
            setSource: (source) => {
                codex.hooks.setSource(() => source().codex ?? {});
                acp.hooks.setSource(() => source().acp ?? {});
            },
            onChange: () => {
                codex.hooks.onChange();
                acp.hooks.onChange();
            },
        };
        hooks.setSource(() => scope.get());
        sctx.effect(() => () => {
            hooks.setSource(() => Config(config ?? {}));
            hooks.onChange();
        });
        hooks.onChange();
        scope.watch(() => hooks.onChange());
    });
}
export { CodexConfig, AcpConfig, CodexAdapter, AcpAdapter, applyCodex, applyAcp, inject, name };
export { AGENT_ADAPTER_NS } from './ns.js';
export default { name, inject, Config, apply };
