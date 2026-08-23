// Integration test: drive CodexAdapter against a real `codex app-server` process.
// Run: npm run build && npm run test:integration
import { CodexAdapter } from '../lib/codex/adapter.js'
import { CodexProcess } from '../lib/codex/client.js'
import { CodexSessionStore } from '../lib/codex/store.js'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// Spy on turn/start params to verify permission derivation on the wire.
const turnStartParams = []
const origRequest = CodexProcess.prototype.request
CodexProcess.prototype.request = function (method, params) {
  if (method === 'turn/start') turnStartParams.push(params)
  return origRequest.call(this, method, params)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-test-'))
const workdir = mkdtempSync(join(tmpdir(), 'dsh-codex-work-'))
const profiles = () => new Map([
  ['codex', {
    command: 'codex',
    args: ['app-server', '--stdio'],
    // No profile cwd on purpose: the adapter must resolve the DSH session's
    // workspace via the sessionCwd resolver below.
    // approvalPolicy: 'never' keeps the primary turns free of approval prompts.
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    defaultContextWindow: 272000,
    defaultMaxTokens: 32768,
  }],
])

const adapter = new CodexAdapter({
  profiles,
  readImage: async () => { throw new Error('no images in test') },
  sessionCwd: () => workdir,
  sessionPermission: () => 'workspace-write',
  registerTools: (sessionId, defs) => { toolsBySession.set(sessionId, defs) },
  store: new CodexSessionStore(join(dir, 'sessions.json'), (m) => console.error('[store]', m)),
  logger: (m) => console.error('[adapter]', m),
})

let msgSeq = 0
const user = (text) => ({ id: `m${++msgSeq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (text) => ({ id: `m${++msgSeq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'codex', model: 'unknown' } })

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const thoughtOf = (chunks) => chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
const finishOf = (chunks) => chunks.filter((c) => c.type === 'finish').at(-1)?.reason

// Display-tool registrations captured per session (stands in for the DSH
// agent-scoped tools registry).
const toolsBySession = new Map()

/**
 * Emulate the agent loop over one turn: consume steps; when a step finishes
 * with tool-calls, "execute" the display-only echo tools (which await codex's
 * recorded outcome), then request the next step.
 */
async function driveTurn(adapter, options) {
  const chunks = []
  const toolCalls = []
  const toolValues = []
  let concluded = 0
  const tools = toolsBySession.get(options.sessionId) ?? []
  for (let step = 0; step < 20; step++) {
    const stepChunks = await collect(adapter.stream(options))
    chunks.push(...stepChunks)
    const finish = finishOf(stepChunks)
    if (finish?.kind !== 'tool-calls') return { chunks, finish, toolCalls, toolValues, concluded, steps: step + 1 }
    const calls = stepChunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').map((c) => c.block)
    toolCalls.push(...calls)
    for (const call of calls) {
      const def = tools.find((t) => t.name === call.name)
      assert.ok(def, `display tool registered for ${call.name}`)
      const exec = { callId: call.id, signal: new AbortController().signal, concluded: false, concludeTurn() { this.concluded = true } }
      const value = await def.execute(JSON.parse(call.arguments), exec)
      toolValues.push({ call, value })
      if (exec.concluded) concluded++
    }
  }
  throw new Error('driveTurn: exceeded 20 steps')
}

const sessionId = 'test-session-1'
let passed = 0
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`✓ ${name}`) }

try {
  // 1. listModels
  const models = await adapter.listModels('codex')
  console.log(`models (${models.length}):`, models.slice(0, 3).map((m) => m.id).join(', '), '...')
  ok('listModels returns models', models.length > 0)
  const model = models.find((m) => /codex/i.test(m.id))?.id ?? models[0].id
  console.log('using model:', model)

  // 2. providerInfo / resolveModel / retry policy
  ok('providerInfo', adapter.providerInfo('codex').id === 'codex')
  const resolved = await adapter.resolveModel('codex', model)
  ok('resolveModel has context', resolved.context.contextWindow > 0)
  ok('resolveModel exposes reasoning efforts', (resolved.reasoning?.efforts.length ?? 0) > 0)
  console.log('efforts:', resolved.reasoning?.efforts.map((e) => e.id).join(', '), '| default:', resolved.reasoning?.defaultEffort)
  ok('retry policy is no-retry', adapter.providerRetryPolicy('codex').maxRetries === 0)

  // 3. purpose short-circuit (must not touch codex)
  const titleChunks = await collect(adapter.stream({ provider: 'codex', model, purpose: 'session-title', messages: [user('how do I reverse a linked list')] }))
  ok('session-title is local', finishOf(titleChunks)?.kind === 'stop' && textOf(titleChunks).length > 0)

  // 3b. the session-title-llm provider frames source messages as JSON inside a
  // plugin-sourced user message; the title must unwrap it, not fall back.
  // Snapshot shape observed in production logs: flattened {seq, text} entries.
  const framed = {
    id: 'framed-1', role: 'user',
    content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages:\n' + JSON.stringify([{ seq: 7, text: '如何部署到生产环境' }]) }],
    source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
  }
  const framedChunks = await collect(adapter.stream({ provider: 'codex', model, purpose: 'session-title', messages: [framed] }))
  ok('framed session-title unwraps the human message', textOf(framedChunks) === '如何部署到生产环境')

  // 3c. content-block shaped entries are accepted too.
  const framedBlocks = {
    id: 'framed-2', role: 'user',
    content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages:\n' + JSON.stringify([{ seq: 1, content: [{ type: 'text', text: 'review the diff' }] }]) }],
    source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
  }
  const framedBlockChunks = await collect(adapter.stream({ provider: 'codex', model, purpose: 'session-title', messages: [framedBlocks] }))
  ok('framed session-title unwraps content blocks', textOf(framedBlockChunks) === 'review the diff')

  // 4. turn 1
  const m1 = user('Remember the number 4242. Reply with exactly: MEM_OK')
  const c1 = await collect(adapter.stream({ provider: 'codex', model, sessionId, messages: [m1] }))
  console.log('turn1 text:', JSON.stringify(textOf(c1).slice(0, 120)), '| thought:', thoughtOf(c1).length, 'chars')
  ok('turn1 finished stop', finishOf(c1)?.kind === 'stop')
  ok('turn1 produced text', textOf(c1).includes('MEM_OK'))
  const usage1 = c1.find((c) => c.type === 'usage')?.usage
  ok('turn1 usage reported', usage1 && usage1.inputTokens > 0)

  // 4b. permission derivation on the wire: DSH 'workspace-write' session mode
  // maps to codex workspaceWrite + auto_review; profile approvalPolicy wins.
  const wire = turnStartParams.at(-1)
  ok('turn carries workspaceWrite sandbox policy', wire?.sandboxPolicy?.type === 'workspaceWrite' && wire.sandboxPolicy.writableRoots.includes(workdir))
  ok('turn carries auto_review reviewer', wire?.approvalsReviewer === 'auto_review')
  ok('profile approvalPolicy override wins', wire?.approvalPolicy === 'never')

  // 5. turn 2 with full history — watermark must send only the new turn
  const a1 = assistant(textOf(c1))
  const m2 = user('What number did I ask you to remember? Reply with just the number.')
  const c2 = await collect(adapter.stream({ provider: 'codex', model, sessionId, messages: [m1, a1, m2] }))
  console.log('turn2 text:', JSON.stringify(textOf(c2).slice(0, 120)))
  ok('turn2 recalls state (thread kept codex-side)', textOf(c2).includes('4242'))

  // 6. tool-using turn: file creation surfaces as a display-only tool call
  const m3 = user('Create a file called codex-it.txt containing the word harness, then reply DONE.')
  const r3 = await driveTurn(adapter, { provider: 'codex', model, sessionId, messages: [m1, a1, m2, assistant(textOf(c2)), m3] })
  ok('turn3 finished', r3.finish?.kind === 'stop')
  ok('tool-call blocks are display tools only', r3.toolCalls.length > 0 && r3.toolCalls.every((c) => /^codex_/.test(c.name)))
  ok('trailing text after tool survives', textOf(r3.chunks).includes('DONE'))
  ok('codex actually wrote the file', readFileSync(join(workdir, 'codex-it.txt'), 'utf8').includes('harness'))

  // 6b. shell-command turn: the command mirrors as a codex_command tool call
  // whose echo replays codex's recorded outcome (and never dispatches work).
  const m4cmd = user('Run the shell command: echo hello-from-codex — then reply with what it printed.')
  const r3b = await driveTurn(adapter, { provider: 'codex', model, sessionId, messages: [m1, a1, m2, assistant(textOf(c2)), m3, assistant(textOf(r3.chunks)), m4cmd] })
  ok('command turn finished', r3b.finish?.kind === 'stop')
  ok('no legacy ⚙️ text blocks', !textOf(r3b.chunks).includes('⚙️'))
  const cmdCall = r3b.toolCalls.find((c) => c.name === 'codex_command')
  ok('codex_command tool call emitted', !!cmdCall && /echo hello-from-codex/.test(JSON.parse(cmdCall.arguments).command))
  const cmdValue = r3b.toolValues.find((v) => v.call === cmdCall)?.value
  ok('echo replays recorded output', typeof cmdValue?.output === 'string' && cmdValue.output.includes('hello-from-codex'))
  ok('echo records exit code', cmdValue?.exitCode === 0)
  const cmdDef = toolsBySession.get(sessionId).find((t) => t.name === 'codex_command')
  const callView = cmdDef.presentCall(JSON.parse(cmdCall.arguments))
  ok('call renders as terminal card', callView?.card === 'terminal' && /echo/.test(callView.title))
  const resultView = cmdDef.presentResult(JSON.parse(cmdCall.arguments), { content: [], isError: false, meta: cmdDef.output.presentationMeta(JSON.parse(cmdCall.arguments), cmdValue) })
  ok('result renders terminal card with exit pill', resultView?.card === 'terminal' && resultView.exitCode === 0 && resultView.output.includes('hello-from-codex'))

  // 7. interrupt (single collect: a real loop throws on the aborted signal
  // between steps rather than calling stream again)
  const ac = new AbortController()
  const m4 = user('Count from 1 to 9999, one number per line. Do not stop early.')
  setTimeout(() => ac.abort(), 2000)
  const c4 = await collect(adapter.stream({ provider: 'codex', model, sessionId, messages: [m1, a1, m2, assistant(textOf(c2)), m3, assistant(textOf(r3.chunks)), m4], signal: ac.signal }))
  console.log('interrupt finish:', JSON.stringify(finishOf(c4)))
  ok('interrupt yields aborted finish', finishOf(c4)?.kind === 'aborted')

  // 8. persistence: a fresh adapter over the same store must resume the codex
  // thread. codex allows only one active writer per thread, so the first
  // adapter's app-server process must exit before the resume — in production
  // this ordering is free (an adapter restart means the harness restarted).
  adapter.dispose()
  const adapter2 = new CodexAdapter({
    profiles,
    readImage: async () => { throw new Error('no images') },
    sessionCwd: () => workdir,
    store: new CodexSessionStore(join(dir, 'sessions.json'), () => {}),
    logger: (m) => console.error('[adapter2]', m),
  })
  const m5 = user('What number did I ask you to remember earlier? Just the number.')
  const c5 = await collect(adapter2.stream({ provider: 'codex', model, sessionId, messages: [m1, a1, m5] }))
  console.log('resumed-thread text:', JSON.stringify(textOf(c5).slice(0, 120)))
  ok('thread/resume restores codex-side state across adapter restarts', textOf(c5).includes('4242'))
  adapter2.dispose()

  // 9. approval bridge: every codex approval request is forwarded to the
  // requestApproval dep; without one the answer fails closed. Profile
  // approvalPolicy 'untrusted' + sandbox 'read-only' forces codex to ask
  // before writing (the reviewer defaults to 'user', i.e. the client).
  const bridgeProfiles = () => new Map([
    ['codex-bridge', {
      command: 'codex',
      args: ['app-server', '--stdio'],
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      defaultContextWindow: 272000,
      defaultMaxTokens: 32768,
    }],
  ])
  const adapterDenied = new CodexAdapter({
    profiles: bridgeProfiles,
    readImage: async () => { throw new Error('no images') },
    sessionCwd: () => workdir,
    store: new CodexSessionStore(join(dir, 'sessions-denied.json'), () => {}),
    logger: () => {},
  })
  const mDeny = user('Create a file called bridge-denied.txt containing the word nope, then reply TRIED.')
  const cDeny = await collect(adapterDenied.stream({ provider: 'codex-bridge', model, sessionId: 'bridge-denied', messages: [mDeny] }))
  ok('bridge without dep still finishes', finishOf(cDeny)?.kind === 'stop')
  let deniedFile = true
  try { readFileSync(join(workdir, 'bridge-denied.txt'), 'utf8'); deniedFile = false } catch { /* expected: never created */ }
  ok('bridge fails closed (file not created)', deniedFile)
  adapterDenied.dispose()

  // 10. bridge accepting through the requestApproval dep lets the command run.
  let sawApproval = null
  const adapterAllow = new CodexAdapter({
    profiles: bridgeProfiles,
    readImage: async () => { throw new Error('no images') },
    sessionCwd: () => workdir,
    requestApproval: async (req) => { sawApproval = req; return 'accept' },
    store: new CodexSessionStore(join(dir, 'sessions-allow.json'), () => {}),
    logger: () => {},
  })
  const mAllow = user('Create a file called bridge-allowed.txt containing the word yep, then reply TRIED.')
  const cAllow = await collect(adapterAllow.stream({ provider: 'codex-bridge', model, sessionId: 'bridge-allowed', messages: [mAllow] }))
  ok('bridged turn finished', finishOf(cAllow)?.kind === 'stop')
  ok('approval request reached the bridge', !!sawApproval && sawApproval.sessionId === 'bridge-allowed')
  ok('approved command actually ran', readFileSync(join(workdir, 'bridge-allowed.txt'), 'utf8').includes('yep'))
  adapterAllow.dispose()

  console.log(`\nALL ${passed} CHECKS PASSED`)
} finally {
  adapter.dispose()
  rmSync(dir, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
  setTimeout(() => process.exit(0), 300)
}
