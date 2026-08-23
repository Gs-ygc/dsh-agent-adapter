// Unit test: the forwarding filter — only genuine human input may reach the
// ACP agent. System prompt, runtime context, tool results, compaction
// checkpoints, and assistant messages must all be excluded. No agent process
// required.
// Run: npm run build && node test/unit.mjs
import { extractUserTurns, overlapLength, synthesizeTitle, TurnPump } from '../lib/acp/adapter.js'
import { permissionOutcome } from '../lib/acp/client.js'
import { AcpToolOutcomes, acpDisplayTools } from '../lib/acp/tools.js'
import { effectiveRoutes, sortAgentRows } from '../lib/acp/agents.js'
import { effectiveRoutes as codexEffectiveRoutes } from '../lib/codex/agents.js'
import { Config as PluginConfig } from '../lib/index.js'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// The package manifest's dsh.client.inject entries are module package names,
// while the loaded client plugin must inject Cordis service names.
let clientRegistration
globalThis.window = { __ModuleLoader__: { load: (registration) => { clientRegistration = registration } } }
await import('../lib/client-ui.js')
delete globalThis.window
const clientPlugin = clientRegistration.factory(createRequire(import.meta.url))
assert.deepEqual(clientPlugin.inject, ['slots', 'locale', 'connection', 'remote'])
console.log('✓ client bundle injects Cordis services, not module package names')

let seq = 0
const msg = (role, kind, text, extra = {}) => ({
  id: `m${++seq}`,
  role,
  content: [{ type: 'text', text }],
  source: { kind, ...extra },
})

// A realistic loop-assembled history: every non-human message flavor present.
const history = [
  msg('user', 'plugin', 'ENVIRONMENT SNAPSHOT: cwd=/repo ...', { plugin: 'dsh-agent-loop', form: 'snapshot', sections: [] }),
  msg('user', 'user', 'first real human question'),
  msg('assistant', 'model', 'agent answer one', { provider: 'opencode', model: 'k3' }),
  msg('user', 'tool', 'tool result payload', { callId: 'call_1' }),
  msg('user', 'plugin', 'compaction checkpoint / summary text', { plugin: 'compact' }),
  msg('user', 'user', 'second real human question'),
  msg('assistant', 'model', 'agent answer two', { provider: 'opencode', model: 'k3' }),
  msg('system', 'plugin', 'system-role injected section', { plugin: 'x' }),
  msg('user', 'user', 'third real human question'),
]

const turns = extractUserTurns(history)
assert.deepEqual(turns.map((t) => t.text), [
  'first real human question',
  'second real human question',
  'third real human question',
])
console.log('✓ only source.kind=user human turns are extracted (context/tool/compaction/system excluded)')

// Fingerprint identity: same text, same fingerprint.
assert.equal(turns[0].fingerprint, 'first real human question')

// Append-only: sent is a strict prefix.
let overlap = overlapLength(['a', 'b'], [{ fingerprint: 'a' }, { fingerprint: 'b' }, { fingerprint: 'c' }])
assert.equal(overlap, 2)
console.log('✓ append-only diff: only the new tail is forwarded')

// Post-compaction: current history starts mid-way through what was sent.
overlap = overlapLength(['a', 'b', 'c', 'd'], [{ fingerprint: 'c' }, { fingerprint: 'd' }, { fingerprint: 'e' }])
assert.equal(overlap, 2)
console.log('✓ post-compaction suffix realignment: only genuinely new turns forward')

// Unalignable rewrite: zero overlap triggers the caller's last-turn-only fallback.
overlap = overlapLength(['x', 'y'], [{ fingerprint: 'a' }, { fingerprint: 'b' }])
assert.equal(overlap, 0)
console.log('✓ unalignable history detected (caller falls back to latest-turn-only)')

// options.system / options.tools are never read by the adapter stream path:
// verified by code inspection — GenerateOptions.system and .tools appear
// nowhere in src/acp/adapter.ts outside the module doc comment.

// Session-title synthesis: dsh-session-title-llm frames human messages as a
// JSON array inside ONE plugin-kind message; the title must come from the
// framed content, not the framing instruction.
const framed = [{
  id: 'mt1',
  role: 'user',
  content: [{
    type: 'text',
    text: 'Generate the session title from this JSON array of human messages:\n' +
      JSON.stringify([{ seq: 7, text: '这个仓库有什么作用' }]),
  }],
  source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
}]
assert.equal(synthesizeTitle(framed), '这个仓库有什么作用')
console.log('✓ session-title recovers the human prompt from the plugin-framed JSON (not "ACP session")')

// Unframed callers: first user text block, whitespace-normalized, 40-char cap.
assert.equal(synthesizeTitle([msg('user', 'user', 'plain question\nsecond line')]), 'plain question second line')
assert.equal(synthesizeTitle([msg('user', 'user', 'x'.repeat(60))]).length, 40)
console.log('✓ unframed title input: raw text, whitespace-collapsed, capped')

// No usable text: stable fallback.
assert.equal(synthesizeTitle([]), 'ACP session')
console.log('✓ title fallback when no text exists')

// Content-block frame shape (defensive alternative encoding).
const framedBlocks = [{
  id: 'mt2',
  role: 'user',
  content: [{
    type: 'text',
    text: 'Generate the session title from this JSON array of human messages:\n' +
      JSON.stringify([{ content: [{ type: 'text', text: 'block shaped frame' }] }]),
  }],
  source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
}]
assert.equal(synthesizeTitle(framedBlocks), 'block shaped frame')
console.log('✓ content-block frame shape also recovered')

// Tool-call display: driven by tool_call_update (real opencode payload shapes
// captured in probe6) — header from title/command/path, streamed output,
// status footer; tool_call pending announcements stay silent.
{
  const pump = new TurnPump(() => {}, new AcpToolOutcomes(), false)
  const chunks = []
  const drain = async () => { for await (const c of pump) chunks.push(c) }
  const draining = drain()
  pump.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', kind: 'execute', status: 'pending', locations: [], rawInput: {} })
  pump.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', kind: 'execute', title: 'echo hello-acp', rawInput: { command: 'echo hello-acp', cwd: '/tmp' }, locations: [{ path: '/tmp' }] })
  pump.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'hello-acp\n' } }] })
  pump.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hello-acp\n' } }], rawOutput: { metadata: { exit: 0 } } })
  pump.settle({ stopReason: 'end_turn' }, undefined)
  await draining
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!chunks.some((c) => c.blockType === 'tool-call' || c.type === 'tool-call-delta'), 'never emits tool-call blocks')
  assert.ok(text.includes('⚙️'), 'header icon present')
  assert.ok(text.includes('echo hello-acp'), 'command line shown')
  assert.ok(text.includes('hello-acp'), 'streamed output shown')
  assert.ok(text.includes('✓ exit 0'), 'completion footer with exit code')
  console.log('✓ tool calls render as display blocks with command, output, and exit status')
}

// Permission outcome mapping (session/request_permission bridging).
{
  const options = [
    { optionId: 'aa', kind: 'allow_always' },
    { optionId: 'ao', kind: 'allow_once' },
    { optionId: 'ro', kind: 'reject_once' },
  ]
  assert.deepEqual(permissionOutcome('allow', options), { outcome: { outcome: 'selected', optionId: 'ao' } })
  assert.deepEqual(permissionOutcome('deny', options), { outcome: { outcome: 'selected', optionId: 'ro' } })
  assert.deepEqual(permissionOutcome('cancel', options), { outcome: { outcome: 'cancelled' } })
  assert.deepEqual(permissionOutcome('allow', []), { outcome: { outcome: 'cancelled' } })
  // allow_always is selected only for the explicit allow_always decision
  // (danger-full-access derivation); interactive allows prefer allow_once.
  assert.deepEqual(permissionOutcome('allow_always', options), { outcome: { outcome: 'selected', optionId: 'aa' } })
  assert.deepEqual(permissionOutcome('allow', [{ optionId: 'aa', kind: 'allow_always' }]), { outcome: { outcome: 'selected', optionId: 'aa' } })
  console.log('✓ permission decisions map onto ACP options (allow_once preferred, fail-closed cancel)')
}

// Effective route gating: detected known agents default on, enable switches
// hide them, custom providers always stay, and same-id overrides win.
{
  const base = { displayName: '', command: 'x', args: [], permissionPolicy: 'auto', defaultContextWindow: 1, defaultMaxTokens: 1 }
  const detected = { opencode: { detected: true, version: '1.0' }, kimi: { detected: true }, pi: { detected: false } }
  // Detected known agents on by default; undetected absent.
  let routes = effectiveRoutes(new Map(), undefined, detected)
  assert.deepEqual([...routes.keys()].sort(), ['kimi', 'opencode'])
  // Disable switch hides a detected agent.
  routes = effectiveRoutes(new Map(), { opencode: { enabled: false } }, detected)
  assert.deepEqual([...routes.keys()].sort(), ['kimi'])
  // Explicit same-id override wins for an enabled agent; custom route always on.
  routes = effectiveRoutes(new Map([
    ['opencode', { ...base, command: 'custom-opencode' }],
    ['mytool', base],
  ]), undefined, detected)
  assert.equal(routes.get('opencode').command, 'custom-opencode')
  assert.ok(routes.has('mytool'))
  // A disabled switch gates even an explicit same-id override.
  routes = effectiveRoutes(new Map([['opencode', { ...base, command: 'custom-opencode' }]]), { opencode: { enabled: false } }, detected)
  assert.ok(!routes.has('opencode'))
  console.log('✓ known-agent routes gate on enable switches; custom providers always enabled')
}

// Codex effective route gating: mirrors the ACP half's known-agent mechanism.
{
  const base = { displayName: '', command: 'x', args: [], defaultContextWindow: 1, defaultMaxTokens: 1 }
  const detected = { codex: { detected: true, version: '0.148.0' } }
  // Detected known agent on by default; undetected absent.
  let routes = codexEffectiveRoutes(new Map(), undefined, detected)
  assert.deepEqual([...routes.keys()], ['codex'])
  // Disable switch hides a detected agent.
  routes = codexEffectiveRoutes(new Map(), { codex: { enabled: false } }, detected)
  assert.deepEqual([...routes.keys()], [])
  // Explicit same-id override wins; custom route always on.
  routes = codexEffectiveRoutes(new Map([
    ['codex', { ...base, command: 'custom-codex' }],
    ['mycodex', base],
  ]), undefined, detected)
  assert.equal(routes.get('codex').command, 'custom-codex')
  assert.ok(routes.has('mycodex'))
  // A disabled switch gates even an explicit same-id override.
  routes = codexEffectiveRoutes(new Map([['codex', { ...base, command: 'custom-codex' }]]), { codex: { enabled: false } }, detected)
  assert.ok(!routes.has('codex'))
  console.log('✓ codex: known-agent route gates on the enable switch; custom providers always enabled')
}

// Settings-page row order: usable (detected/configured) rows first, codex
// (priority 0) ahead of the ACP agents (priority 10+), stable within ties.
{
  const row = (id, detected, priority, configured = false) => ({ id, detected, configured, priority })
  const sorted = sortAgentRows([
    row('pi', false, 12),
    row('opencode', true, 10),
    row('codex', true, 0),
    row('kimi', false, 11),
  ])
  assert.deepEqual(sorted.map((r) => r.id), ['codex', 'opencode', 'kimi', 'pi'])
  // An undetected codex sinks below usable ACP rows; an explicitly configured
  // but undetected agent still counts as usable.
  const sorted2 = sortAgentRows([
    row('opencode', true, 10),
    row('codex', false, 0),
    row('pi', false, 12, true),
  ])
  assert.deepEqual(sorted2.map((r) => r.id), ['opencode', 'pi', 'codex'])
  console.log('✓ settings page rows sort usable-first with codex leading')
}

// Echo mode: a tool_call_update emits a `tool-call` block and flushes the step
// with a `tool-calls` finish; the loop "executes" the display-only echo tool,
// which replays the outcome the adapter publishes; trailing text streams in
// the next step (echo resolves non-final), while a turn ending right after
// the tool concludes through the final echo (concludeTurn).
{
  const outcomes = new AcpToolOutcomes()
  const defs = acpDisplayTools(outcomes)
  const pump = new TurnPump(() => {}, outcomes, true)
  pump.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', kind: 'execute', status: 'pending', rawInput: {} })
  pump.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', title: 'echo hi', rawInput: { command: 'echo hi', cwd: '/tmp' } })
  const step1 = []
  for await (const c of pump.step()) step1.push(c)
  const block = step1.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')?.block
  assert.equal(block?.name, 'acp_command')
  assert.deepEqual(JSON.parse(block.arguments), { command: 'echo hi', cwd: '/tmp' })
  assert.equal(step1.at(-1).reason?.kind, 'tool-calls')
  // The loop executes the echo.
  let concluded = false
  const ac = new AbortController()
  const echoPromise = defs.find((d) => d.name === 'acp_command')
    .execute({}, { callId: block.id, signal: ac.signal, concludeTurn: () => { concluded = true } })
  // The call completes, trailing text follows, then the turn ends.
  pump.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }], rawOutput: { metadata: { exit: 0 } } })
  pump.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DONE' } })
  pump.settle({ stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 1 } }, undefined)
  const outcome = await echoPromise
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.exitCode, 0)
  assert.equal(outcome.final, false) // trailing text must stream in one more step
  assert.ok(!concluded)
  const step2 = []
  for await (const c of pump.step()) step2.push(c)
  assert.equal(step2.at(-1).reason?.kind, 'stop')
  assert.ok(step2.some((c) => c.type === 'text-delta' && c.text === 'DONE'))
  assert.ok(step2.some((c) => c.type === 'usage'))
  console.log('✓ echo mode: tool-call block flushes the step; echo replays the ACP outcome; trailing text streams next step')
}

// Echo mode, final echo: turn ends with no trailing chunks — the echo
// concludes the DSH turn (no trailing empty step).
{
  const outcomes = new AcpToolOutcomes()
  const defs = acpDisplayTools(outcomes)
  const pump = new TurnPump(() => {}, outcomes, true)
  pump.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't9', status: 'in_progress', kind: 'read', title: 'read', locations: [{ path: '/tmp/x.txt' }] })
  const step1 = []
  for await (const c of pump.step()) step1.push(c)
  const block = step1.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')?.block
  assert.equal(block?.name, 'acp_tool')
  assert.deepEqual(JSON.parse(block.arguments), { title: 'read', kind: 'read', path: '/tmp/x.txt' })
  let concluded = false
  const echoPromise = defs.find((d) => d.name === 'acp_tool')
    .execute({}, { callId: block.id, signal: new AbortController().signal, concludeTurn: () => { concluded = true } })
  pump.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't9', status: 'completed' })
  pump.settle({ stopReason: 'end_turn' }, undefined)
  const outcome = await echoPromise
  assert.equal(outcome.final, true)
  assert.ok(concluded)
  console.log('✓ echo mode: turn-terminal echo concludes the DSH turn (concludeTurn)')
}

// Unified `agent-adapter` namespace: the combined Config is the single
// section's schema; the halves expose hooks and no longer self-register
// `llm-codex` / `llm-acp` namespaces.
{
  const empty = { codex: { providers: {}, agents: {} }, acp: { providers: {}, agents: {} } }
  assert.deepEqual(PluginConfig({}), empty)
  assert.deepEqual(PluginConfig(undefined), empty)
  const withProvider = PluginConfig({ codex: { providers: { codex: { command: 'codex' } } } })
  assert.deepEqual(withProvider.codex.providers.codex.args, ['app-server', '--stdio'])
  const codexCode = readFileSync(new URL('../lib/codex/index.js', import.meta.url), 'utf8')
  const acpCode = readFileSync(new URL('../lib/acp/index.js', import.meta.url), 'utf8')
  assert.ok(!codexCode.includes("settingsNamespace('llm-codex')"), 'codex half must not self-register llm-codex')
  assert.ok(!acpCode.includes("settingsNamespace('llm-acp')"), 'acp half must not self-register llm-acp')
  const nsCode = readFileSync(new URL('../lib/ns.js', import.meta.url), 'utf8')
  assert.ok(nsCode.includes("settingsNamespace('agent-adapter')"), 'ns module owns the unified namespace')
  assert.ok(codexCode.includes("['codex', 'providers', provider]"), 'codex directory entries nest under the unified ns')
  assert.ok(acpCode.includes("['acp', 'providers', provider]"), 'acp directory entries nest under the unified ns')
  console.log('✓ unified agent-adapter namespace: combined Config schema; halves expose hooks, no self-registration')
}

console.log('\nALL UNIT CHECKS PASSED')
