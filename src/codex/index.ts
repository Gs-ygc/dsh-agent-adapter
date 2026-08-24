/**
 * codex half of dsh-agent-adapter: codex app-server adapter for the DeepSeek
 * Harness LLM seam. Each configured provider route spawns one long-lived
 * `codex app-server` process; DSH sessions bound to that route hold their
 * conversation inside a codex thread, making codex itself the session's
 * conversation partner.
 *
 * Routes come from two sources: explicit `agent-adapter.codex.providers`
 * profiles, and the known-agent scan — a locally installed `codex` is
 * detected on PATH and enabled by default; the settings page toggles it via
 * `agent-adapter.codex.agents.codex.enabled`. Settings changes hot-swap the
 * registered route set; removed routes dispose their processes.
 *
 * The client half (settings page) reads detection + enablement through the
 * `/plugins/dsh-agent-adapter/state.json` web route served by the ACP half,
 * which folds this half's `contribution()` state into the payload.
 *
 * @module dsh-agent-adapter/codex
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { deepEqualJson } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import { CodexAdapter } from './adapter.js'
import { effectiveRoutes, KNOWN_CODEX_AGENTS, scanInstalledAgents, type AgentDetection } from './agents.js'
import { Config, resolveProfiles, type ResolvedProfile } from './config.js'
import { CodexSessionStore } from './store.js'
import { AGENT_ADAPTER_NS, type SettingsHooks } from '../ns.js'

/** Default location of the durable DSH↔codex thread mapping. */
function defaultStateFile(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'llm-codex', 'sessions.json')
}

/** Read a host-plane service not declared on the cordis Context type. */
function hostGet(ctx: Context, key: string): unknown {
  return (ctx as unknown as { get(name: string): unknown }).get(key)
}

/** Config accepted by applyCodex; the codex slice of the combined plugin. */
export interface RawConfig {
  providers?: Record<string, ResolvedProfile>
  agents?: Record<string, { enabled?: boolean }>
}

/** One codex agent row folded into the settings page's scan payload. */
export interface CodexAgentRow {
  ns: 'agent-adapter'
  id: string
  name: string
  command: string
  detected: boolean
  version?: string
  enabled: boolean
  configured: boolean
  /** Full settings path of this row's enable switch within the namespace. */
  switchPath: string[]
  /** Settings-page order: codex leads the usable group (ACP rows start at 10). */
  priority: number
}

export function applyCodex(ctx: Context, config: RawConfig) {
  let current = () => config
  // Detection state: seeded at apply, refreshed on settings change and on
  // state-endpoint reads, so the settings page always sees a fresh scan.
  let detections: Record<string, AgentDetection> = {}
  let scanning: Promise<void> | undefined
  const rescan = () => {
    scanning ??= scanInstalledAgents()
      .then((found) => {
        detections = found
        onTopologyMaybeChanged()
      })
      .catch((error) => ctx.logger.warn(`llm-codex: agent scan failed: ${error}`))
      .finally(() => { scanning = undefined })
    return scanning
  }

  let lastRaw: unknown
  let memoized: Map<string, ResolvedProfile> | undefined
  const profiles = () => {
    const raw = current()
    const key = `${JSON.stringify(raw)}|${JSON.stringify(detections)}`
    if (key === lastRaw && memoized !== undefined) return memoized
    const explicit = resolveProfiles(raw.providers)
    const next = effectiveRoutes(explicit, raw.agents, detections)
    lastRaw = key
    memoized = next
    return next
  }
  profiles()

  // Per-session disposers for the display-only codex tool registrations, so
  // a re-registration (plugin reload over a live agent) replaces the stale
  // definitions that close over the previous adapter's outcome registry.
  const toolDisposers = new Map<string, Array<() => void>>()
  ctx.effect(() => () => {
    for (const disposers of toolDisposers.values()) for (const dispose of disposers) dispose()
    toolDisposers.clear()
  })

  const adapter = new CodexAdapter({
    profiles,
    readImage: async (ref) => {
      const attachments = ctx.get('attachments')
      if (!attachments) throw new Error('llm-codex: attachments service unavailable; cannot forward images')
      return attachments.readImage(ref)
    },
    // The sessions service is host-plane but not declared on the cordis
    // Context type; read it defensively and only trust an absolute cwd.
    sessionCwd: (sessionId) => {
      const sessions = hostGet(ctx, 'sessions') as
        | { get(id: string): { header?: { cwd?: unknown } } | undefined }
        | undefined
      const cwd = sessions?.get(sessionId)?.header?.cwd
      return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : undefined
    },
    // The session's effective sandbox mode: the logged override wins, then the
    // deployment default.
    sessionPermission: (sessionId) => {
      const sessions = hostGet(ctx, 'sessions') as { get(id: string): unknown } | undefined
      const sandboxPolicy = hostGet(ctx, 'sandboxPolicy') as
        | { overrideOf(session: unknown): string | undefined; defaultMode: string }
        | undefined
      if (!sandboxPolicy) return undefined
      const session = sessions?.get(sessionId)
      const mode = (session ? sandboxPolicy.overrideOf(session) : undefined) ?? sandboxPolicy.defaultMode
      return typeof mode === 'string' ? mode : undefined
    },
    // Bridge codex approval prompts into the DSH approval service. The
    // request requires an open turn — codex only asks mid-turn, while the
    // harness stream call (and its step) is running.
    requestApproval: async ({ sessionId, kind, command, reason, signal }) => {
      const approval = hostGet(ctx, 'approval') as
        | { request(req: { agent: unknown; toolName: string; reason?: string; signal?: AbortSignal }): Promise<string> }
        | undefined
      const agents = hostGet(ctx, 'agents') as
        | { get(id: string): unknown }
        | undefined
      const agent = agents?.get(sessionId)
      if (!approval || !agent) return undefined // fail closed
      const toolName = kind === 'command'
        ? 'codex (shell command)'
        : kind === 'fileChange'
          ? 'codex (file change)'
          : 'codex (permission request)'
      const why = [command, reason].filter(Boolean).join('\n') || undefined
      try {
        const outcome = await approval.request({ agent, toolName, ...(why ? { reason: why } : {}), ...(signal ? { signal } : {}) })
        if (outcome === 'allowed-once') return 'accept'
        if (outcome === 'rejected') return 'decline'
        return 'cancel' // cancelled | unavailable
      } catch {
        return undefined // fail closed
      }
    },
    // Register the display-only codex tools on the session's own agent scope,
    // so they shadow nothing globally and unwind with the agent.
    registerTools: (sessionId, definitions) => {
      const agents = hostGet(ctx, 'agents') as
        | { get(id: string): { ctx?: { tools?: { register(def: unknown): () => void } } } | undefined }
        | undefined
      const tools = agents?.get(sessionId)?.ctx?.tools
      if (!tools) throw new Error('llm-codex: agent tools registry unavailable')
      for (const dispose of toolDisposers.get(sessionId) ?? []) dispose()
      toolDisposers.set(sessionId, definitions.map((def) => tools.register(def)))
    },
    store: new CodexSessionStore(defaultStateFile(), (message) => ctx.logger.warn(message)),
    logger: (message) => ctx.logger.warn(message),
  })
  ctx.effect(() => () => adapter.dispose())

  // No configurable-provider directory registration: the Models settings
  // page's generic editor only understands API-key-style profiles, so agent
  // routes (command/args profiles) would show up there as uneditable rows.
  // Agent management lives on the「Agent 适配」settings page instead.

  let registration: { replace(routes: string[]): void } | undefined
  let registeredRoutes: string[] | undefined
  const ensureRegistration = () => {
    const routes = [...profiles().keys()].sort()
    if (deepEqualJson(routes, registeredRoutes)) return
    if (registration === undefined) {
      if (routes.length === 0) {
        registeredRoutes = routes
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredRoutes = routes
  }

  const onTopologyMaybeChanged = () => {
    try {
      adapter.reconcileRoutes()
      ensureRegistration()
    } catch (error) {
      ctx.logger.error('llm-codex: keeping the previously registered routes after a refused update')
      ctx.logger.error(error)
    }
  }

  // State contribution folded into the ACP half's settings-page payload: the
  // known codex agent with detection, version, and effective enablement.
  // Reads trigger a rescan so the page never renders a stale probe.
  const contribution = async (): Promise<{ agents: CodexAgentRow[]; customs: string[] }> => {
    await rescan()
    const raw = current()
    const agents = KNOWN_CODEX_AGENTS.map((agent): CodexAgentRow => ({
      ns: 'agent-adapter',
      id: agent.id,
      name: agent.displayName,
      command: [agent.command, ...agent.args].join(' '),
      detected: detections[agent.id]?.detected ?? false,
      ...(detections[agent.id]?.version ? { version: detections[agent.id]!.version } : {}),
      enabled: raw.agents?.[agent.id]?.enabled !== false,
      configured: raw.providers?.[agent.id] !== undefined,
      switchPath: ['codex', 'agents', agent.id, 'enabled'],
      priority: 0,
    }))
    const customs = Object.keys(raw.providers ?? {}).filter((id) => !KNOWN_CODEX_AGENTS.some((a) => a.id === id))
    return { agents, customs }
  }

  // rescan() applies the resulting topology itself.
  void rescan()

  // The combined entry wires these hooks into the single `agent-adapter`
  // settings section. Without a settings service they never fire and this
  // half keeps its composition slice (`current` stays the entry config).
  const hooks: SettingsHooks<RawConfig> = {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      // Enable switches may hide routes without a rescan; command overrides
      // may change what should be detected. Do both.
      onTopologyMaybeChanged()
      void rescan()
    },
  }

  return { contribution, hooks }
}

export { Config, CodexAdapter }
