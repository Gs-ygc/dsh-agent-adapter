/**
 * dsh-agent-adapter client half: the Agent Adapter settings section. Renders
 * the known-agent scan for both halves — codex (app-server) and ACP agents
 * (opencode, kimi, pi, …) — fetched from the host
 * `/plugins/dsh-agent-adapter/state.json` route, with per-agent enable
 * switches that write `agent-adapter.codex.agents.<id>.enabled` /
 * `agent-adapter.acp.agents.<id>.enabled` (each row carries its full
 * `switchPath`) through the ordinary settings mutation channel; the host
 * hot-reloads routes.
 *
 * @module dsh-agent-adapter/client
 */
import { useCallback, useEffect, useState } from 'react'
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime'

const name = 'agent-adapter-client'
const inject = [
  'slots',
  'locale',
  'connection',
  'remote',
]
// Locale namespace for this settings page's dictionaries (the settings mutate
// namespace is per-row — see AgentRow.ns — so a single page can toggle both
// the codex and ACP halves).
const NS = 'agent-adapter'
const STATE_URL = '/plugins/dsh-agent-adapter/state.json'

const zh = {
  nav: 'Agent 适配',
  title: 'Agent 适配',
  intro: '扫描本机已安装的 agent 服务（codex、opencode、kimi、pi 等），检测到的默认启用。只有启用的服务才会出现在模型选择器中。',
  installed: '已安装',
  missing: '未检测到',
  enabled: '已启用',
  disabled: '已停用',
  configured: '自定义配置',
  customs: (n: number) => `另有 ${n} 个手动配置的 provider（settings.yaml 的 agent-adapter.codex.providers / agent-adapter.acp.providers），始终启用。`,
  loading: '正在扫描本机 agent 服务…',
  loadFailed: '扫描状态读取失败',
  retry: '重试',
}
const en = {
  nav: 'Agent Adapter',
  title: 'Agent Adapter',
  intro: 'Locally installed agent adapters (codex, opencode, kimi, pi, …) are detected and enabled by default. Only enabled agents appear in the model picker.',
  installed: 'Installed',
  missing: 'Not detected',
  enabled: 'Enabled',
  disabled: 'Disabled',
  configured: 'Custom config',
  customs: (n: number) => `${n} manually configured provider(s) in settings.yaml (agent-adapter.codex.providers / agent-adapter.acp.providers) are always enabled.`,
  loading: 'Scanning for local agents…',
  loadFailed: 'Failed to read the scan state',
  retry: 'Retry',
}

interface AgentRow {
  id: string
  /** Settings namespace this row's switch mutates (unified: `agent-adapter`). */
  ns: string
  /** Full settings path of this row's enable switch within the namespace. */
  switchPath: string[]
  name: string
  command: string
  detected: boolean
  version?: string
  enabled: boolean
  configured: boolean
}
interface ScanState {
  agents: AgentRow[]
  customs: string[]
}

interface SectionProps {
  api?: { settings: { mutate(req: { ns: string; ops: Array<{ op: 'set'; path: string[]; value: unknown }> }): Promise<{ result: { ok: boolean; error?: { message: string } } }> } }
  subscribeDoc?: (cb: () => void) => () => void
  t: (key: keyof typeof zh, ...args: number[]) => string
}

function AcpSection(props: SectionProps) {
  const { api, subscribeDoc, t } = props
  const [state, setState] = useState<ScanState | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(STATE_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setState(await res.json() as ScanState)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    return subscribeDoc?.(() => void refresh())
  }, [refresh, subscribeDoc])

  const toggle = async (row: AgentRow) => {
    if (!api || busy) return
    setBusy(row.id)
    try {
      const next = !row.enabled
      const response = await api.settings.mutate({
        ns: row.ns ?? 'agent-adapter',
        ops: [{ op: 'set', path: row.switchPath ?? ['acp', 'agents', row.id, 'enabled'], value: next }],
      })
      if (!response.result.ok) throw new Error(response.result.error?.message ?? 'mutate failed')
      // Optimistic: reflect immediately; the document event refetches.
      setState((prev) => prev && { ...prev, agents: prev.agents.map((a) => (a.id === row.id ? { ...a, enabled: next } : a)) })
    } catch {
      void refresh()
    } finally {
      setBusy(undefined)
    }
  }

  if (failed) return _jsxs('section', { className: 'dshAcp_section', children: [
    _jsx('h2', { className: 'dshAcp_title', children: t('title') }),
    _jsxs('p', { className: 'dshAcp_error', children: [t('loadFailed'), ' ', _jsx('button', { className: 'dshAcp_link', onClick: () => void refresh(), children: t('retry') })] }),
  ] })
  if (!state) return _jsxs('section', { className: 'dshAcp_section', children: [
    _jsx('h2', { className: 'dshAcp_title', children: t('title') }),
    _jsx('p', { className: 'dshAcp_intro', children: t('loading') }),
  ] })

  return _jsxs('section', { className: 'dshAcp_section', children: [
    _jsx('h2', { className: 'dshAcp_title', children: t('title') }),
    _jsx('p', { className: 'dshAcp_intro', children: t('intro') }),
    _jsx('ul', { className: 'dshAcp_rows', children: state.agents.map((row) => {
      const usable = row.detected || row.configured
      return _jsxs('li', { className: 'dshAcp_row', children: [
        _jsxs('div', { className: 'dshAcp_rowMain', children: [
          _jsxs('div', { className: 'dshAcp_rowHead', children: [
            _jsx('span', { className: 'dshAcp_rowName', children: row.name }),
            _jsx('span', { className: `dshAcp_dot ${usable ? 'dshAcp_dotOn' : 'dshAcp_dotOff'}` }),
            _jsx('span', { className: 'dshAcp_rowTag', children: usable ? t('installed') + (row.version ? ` · ${row.version}` : '') : t('missing') }),
            row.configured && _jsx('span', { className: 'dshAcp_rowTag', children: t('configured') }),
          ] }),
          _jsx('code', { className: 'dshAcp_command', children: row.command }),
        ] }),
        _jsx('button', {
          className: `dshAcp_switch ${row.enabled ? 'dshAcp_switchOn' : ''}`,
          role: 'switch',
          'aria-checked': row.enabled,
          disabled: !usable || busy === row.id,
          title: row.enabled ? t('enabled') : t('disabled'),
          onClick: () => void toggle(row),
          children: _jsx('span', { className: 'dshAcp_knob' }),
        }),
      ] }, row.id)
    }) }),
    state.customs.length > 0 && _jsx('p', { className: 'dshAcp_intro', children: t('customs', state.customs.length) }),
  ] })
}

const CSS = `
.dshAcp_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.dshAcp_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.dshAcp_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
.dshAcp_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}
.dshAcp_link{color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;font:inherit;text-decoration:underline;padding:0}
.dshAcp_rows{flex-direction:column;gap:8px;margin:4px 0 0;padding:0;list-style:none;display:flex}
.dshAcp_row{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;align-items:center;gap:12px;padding:12px 14px;display:flex}
.dshAcp_rowMain{flex-direction:column;gap:4px;min-width:0;flex:1;display:flex}
.dshAcp_rowHead{align-items:center;gap:8px;display:flex}
.dshAcp_rowName{font-size:14px;font-weight:500;line-height:22px}
.dshAcp_dot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}
.dshAcp_dotOn{background:var(--dsw-alias-state-success-primary)}
.dshAcp_dotOff{background:var(--dsw-alias-label-dimmed)}
.dshAcp_rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}
.dshAcp_command{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,monospace);font-size:12px;overflow-wrap:anywhere}
.dshAcp_switch{box-sizing:border-box;width:36px;height:20px;flex:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);position:relative;padding:0;transition:background .15s}
.dshAcp_switchOn{background:var(--dsw-alias-button-primary-fill);border-color:transparent}
.dshAcp_switch:disabled{opacity:.4;cursor:default}
.dshAcp_knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:left .15s}
.dshAcp_switchOn .dshAcp_knob{left:18px;background:var(--dsw-alias-label-primary-foreground,#fff)}
`

function apply(ctx: any) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-adapter: copy dictionaries')
  const t = ctx.locale.bind(NS)
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  ctx.effect(() => () => style.remove())
  const remote = ctx.get('remote')
  const injected = () => ({
    api: ctx.get('connection')?.api,
    subscribeDoc: remote ? (cb: () => void) => remote.$on('settings/document-updated', cb) : undefined,
    t,
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'acp',
    order: 30,
    label: () => t('nav'),
    inject: injected,
  }, AcpSection as never))
}

export { apply, inject, name }
export default { name, inject, apply }
