// Integration test: drive AcpAdapter against a real `opencode acp` process.
// Run: npm run build && npm run test:integration
import { AcpAdapter } from '../lib/acp/adapter.js'
import { AcpSessionStore } from '../lib/acp/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'dsh-acp-test-'))
const workdir = mkdtempSync(join(tmpdir(), 'dsh-acp-work-'))
const profiles = () => new Map([
  ['opencode', {
    command: 'opencode',
    args: ['acp', '--log-level', 'ERROR'],
    cwd: workdir,
    permissionPolicy: 'allow',
    defaultContextWindow: 200000,
    defaultMaxTokens: 32768,
  }],
])

const adapter = new AcpAdapter({
  profiles,
  readImage: async () => { throw new Error('no images in test') },
  store: new AcpSessionStore(join(dir, 'sessions.json'), (m) => console.error('[store]', m)),
  logger: (m) => console.error('[adapter]', m),
})

let msgSeq = 0
const user = (text) => ({ id: `m${++msgSeq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (text) => ({ id: `m${++msgSeq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'opencode', model: 'unknown' } })

async function collect(stream, signal) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const thoughtOf = (chunks) => chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
const finishOf = (chunks) => chunks.filter((c) => c.type === 'finish').at(-1)?.reason

const sessionId = 'test-session-1'
let passed = 0
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`✓ ${name}`) }

try {
  // 1. listModels
  const models = await adapter.listModels('opencode')
  console.log(`models (${models.length}):`, models.slice(0, 3).map((m) => m.id).join(', '), '...')
  ok('listModels returns models', models.length > 0)

  // 2. providerInfo / resolveModel / retry policy
  ok('providerInfo', adapter.providerInfo('opencode').id === 'opencode')
  const resolved = await adapter.resolveModel('opencode', models[0].id)
  ok('resolveModel has context', resolved.context.contextWindow > 0)
  ok('retry policy is no-retry', adapter.providerRetryPolicy('opencode').maxRetries === 0)

  // 2b. reasoning effort discovery (thought_level appears per current model agent-side)
  // kimi-for-coding models are billing-limited in this environment; conversation
  // and effort turns prefer the free opencode models, while effort DISCOVERY can
  // still read kimi config options (no prompt, no billing).
  const conversationModel = models.find((m) => m.id === 'opencode/big-pickle')
    ?? models.find((m) => !m.id.startsWith('kimi-for-coding/'))
    ?? models[0]
  const reasoningModel = models.find((m) => m.id === 'opencode/x-preview-f-free')
    ?? models.find((m) => m.id.includes('k3-256k'))
    ?? models[0]
  const resolvedReasoning = await adapter.resolveModel('opencode', reasoningModel.id)
  console.log(`efforts for ${reasoningModel.id}:`, resolvedReasoning.reasoning?.efforts?.map((e) => e.id).join(',') ?? '(none)', '| default:', resolvedReasoning.reasoning?.defaultEffort ?? '(none)')
  ok('reasoning efforts discovered', (resolvedReasoning.reasoning?.efforts?.length ?? 0) > 0)
  const plainModel = models.find((m) => m.id.includes('big-pickle'))
  if (plainModel) {
    const resolvedPlain = await adapter.resolveModel('opencode', plainModel.id)
    ok('non-reasoning model exposes no efforts', resolvedPlain.reasoning === undefined)
  }

  // 3. purpose short-circuit (must not touch the agent); title comes from the
  // plugin-framed JSON exactly as dsh-session-title-llm sends it
  const framedTitleMsg = {
    id: 'mt0', role: 'user',
    content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages:\n' + JSON.stringify([{ seq: 7, text: 'how do I reverse a linked list' }]) }],
    source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
  }
  const titleChunks = await collect(adapter.stream({ provider: 'opencode', model: conversationModel.id, purpose: 'session-title', messages: [framedTitleMsg] }))
  ok('session-title is local', finishOf(titleChunks)?.kind === 'stop' && textOf(titleChunks).length > 0)
  ok('session-title reflects the human prompt', textOf(titleChunks).includes('reverse a linked list'))

  // 4. turn 1
  const m1 = user('Remember the number 4242. Reply with exactly: MEM_OK')
  const c1 = await collect(adapter.stream({ provider: 'opencode', model: conversationModel.id, sessionId, messages: [m1] }))
  console.log('turn1 text:', JSON.stringify(textOf(c1).slice(0, 120)), '| thought:', thoughtOf(c1).length, 'chars')
  ok('turn1 finished stop', finishOf(c1)?.kind === 'stop')
  ok('turn1 produced text', textOf(c1).includes('MEM_OK'))
  const usage1 = c1.find((c) => c.type === 'usage')?.usage
  ok('turn1 usage reported', usage1 && usage1.inputTokens > 0)

  // 5. turn 2 with full history — watermark must send only the new turn
  const a1 = assistant(textOf(c1))
  const m2 = user('What number did I ask you to remember? Reply with just the number.')
  const c2 = await collect(adapter.stream({ provider: 'opencode', model: conversationModel.id, sessionId, messages: [m1, a1, m2] }))
  console.log('turn2 text:', JSON.stringify(textOf(c2).slice(0, 120)))
  ok('turn2 recalls state (session kept agent-side)', textOf(c2).includes('4242'))

  // 6. tool-using turn (display blocks must not be tool-call blocks)
  const m3 = user('Create a file called acp-it.txt containing the word harness, then reply DONE.')
  const c3 = await collect(adapter.stream({ provider: 'opencode', model: conversationModel.id, sessionId, messages: [m1, a1, m2, assistant(textOf(c2)), m3] }), undefined)
  ok('turn3 finished', finishOf(c3)?.kind === 'stop')
  ok('no tool-call blocks ever emitted', !c3.some((c) => c.blockType === 'tool-call' || c.type === 'tool-call-delta'))
  ok('tool execution is visible as display blocks', textOf(c3).includes('⚙️'))
  const { readFileSync } = await import('node:fs')
  ok('opencode actually wrote the file', readFileSync(join(workdir, 'acp-it.txt'), 'utf8').includes('harness'))

  // 6b. echo display tools (simulated loop): the tool call becomes a real
  // tool-call block + tool-calls finish; the echo tool replays the ACP outcome.
  const echoDefs = []
  const adapterEcho = new AcpAdapter({
    profiles,
    readImage: async () => { throw new Error('no images') },
    registerTools: (_id, defs) => echoDefs.push(...defs),
    store: new AcpSessionStore(join(dir, 'sessions-echo.json'), () => {}),
    logger: () => {},
  })
  const mEcho = user('Run this exact shell command: echo acp-echo-42 — then reply with exactly: ECHO_DONE')
  const cEchoA = await collect(adapterEcho.stream({ provider: 'opencode', model: conversationModel.id, sessionId: 'test-echo', messages: [mEcho] }))
  ok('echo mode: first step ends with tool-calls finish', finishOf(cEchoA)?.kind === 'tool-calls')
  const echoBlock = cEchoA.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')?.block
  ok('echo mode: tool-call block names the acp_command echo tool', echoBlock?.name === 'acp_command')
  const echoArgs = JSON.parse(echoBlock?.arguments ?? '{}')
  ok('echo mode: arguments carry the real command', typeof echoArgs.command === 'string' && echoArgs.command.includes('echo acp-echo-42'))
  const echoDef = echoDefs.find((d) => d.name === 'acp_command')
  ok('echo mode: display tools were registered on the session', echoDef !== undefined)
  const echoOutcomePromise = echoDef.execute(echoArgs, { callId: echoBlock.id, signal: new AbortController().signal, concludeTurn: () => {} })
  const cEchoB = await collect(adapterEcho.stream({ provider: 'opencode', model: conversationModel.id, sessionId: 'test-echo', messages: [mEcho] }))
  const echoOutcome = await echoOutcomePromise
  ok('echo mode: echo replays the recorded outcome', echoOutcome.status === 'completed' && echoOutcome.exitCode === 0 && (echoOutcome.output ?? '').includes('acp-echo-42'))
  ok('echo mode: terminal card content renders command + exit', echoDef.output.render(echoArgs, echoOutcome)[0].text.includes('exit 0'))
  ok('echo mode: turn completes stop on the next step', finishOf(cEchoB)?.kind === 'stop')
  adapterEcho.dispose()

  // 7. cancel
  const ac = new AbortController()
  const m4 = user('Count from 1 to 9999, one number per line. Do not stop early.')
  setTimeout(() => ac.abort(), 2000)
  const c4 = await collect(adapter.stream({ provider: 'opencode', model: conversationModel.id, sessionId, messages: [m1, a1, m2, assistant(textOf(c2)), m3, assistant(textOf(c3)), m4], signal: ac.signal }))
  console.log('cancel finish:', JSON.stringify(finishOf(c4)))
  ok('cancel yields aborted finish', finishOf(c4)?.kind === 'aborted')

  // 8. persistence: a fresh adapter over the same store must reload the ACP session
  const adapter2 = new AcpAdapter({
    profiles,
    readImage: async () => { throw new Error('no images') },
    store: new AcpSessionStore(join(dir, 'sessions.json'), () => {}),
    logger: () => {},
  })
  const m5 = user('What number did I ask you to remember earlier? Just the number.')
  const c5 = await collect(adapter2.stream({ provider: 'opencode', model: conversationModel.id, sessionId, messages: [m1, a1, m5] }))
  console.log('reloaded-session text:', JSON.stringify(textOf(c5).slice(0, 120)))
  ok('session/load restores agent-side state across adapter restarts', textOf(c5).includes('4242'))
  adapter2.dispose()

  // 9. effort sync: explicit reasoningEffort is applied agent-side without error
  const m6 = user('Reply with exactly: EFFORT_OK')
  const c6 = await collect(adapter.stream({ provider: 'opencode', model: reasoningModel.id, reasoningEffort: 'high', sessionId: 'test-session-effort', messages: [m6] }))
  ok('effort-synced turn finished stop', finishOf(c6)?.kind === 'stop' && textOf(c6).includes('EFFORT_OK'))

  // 10. workspace rooting: the ACP session must be created in the DSH
  // SESSION's workspace, not the agent process cwd (regression: opencode once
  // described the harness repo because the session inherited process.cwd()).
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-acp-workspace-'))
  const adapter3 = new AcpAdapter({
    profiles,
    readImage: async () => { throw new Error('no images') },
    store: new AcpSessionStore(join(dir, 'sessions3.json'), () => {}),
    resolveSessionCwd: (id) => (id === 'test-session-workspace' ? workspace : undefined),
    logger: () => {},
  })
  const m7 = user('Create a file named where-am-i.txt containing the word workspace, then reply DONE.')
  const c7 = await collect(adapter3.stream({ provider: 'opencode', model: conversationModel.id, sessionId: 'test-session-workspace', messages: [m7] }))
  ok('workspace-rooted turn finished', finishOf(c7)?.kind === 'stop')
  const { existsSync } = await import('node:fs')
  ok('agent acted in the session workspace, not the process cwd', existsSync(join(workspace, 'where-am-i.txt')) && !existsSync(join(workdir, 'where-am-i.txt')))
  const stored = JSON.parse(readFileSync(join(dir, 'sessions3.json'), 'utf8'))
  ok('stored session records the workspace cwd', stored.opencode['test-session-workspace'].cwd === workspace)
  adapter3.dispose()
  rmSync(workspace, { recursive: true, force: true })

  console.log(`\nALL ${passed} CHECKS PASSED`)
} finally {  adapter.dispose()
  rmSync(dir, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
  setTimeout(() => process.exit(0), 300)
}
