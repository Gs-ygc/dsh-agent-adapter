/**
 * ACP (Agent Client Protocol) stdio client: one child process speaking
 * newline-delimited JSON-RPC 2.0, with the client-side request surface
 * (permission / fs / terminal) and per-session update dispatch.
 *
 * @module dsh-agent-adapter/acp/client
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as readline from 'node:readline'

/** One ACP content block inside a prompt or an update. */
export interface AcpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  [key: string]: unknown
}

/** A `session/update` notification payload. */
export interface AcpSessionUpdate {
  sessionId: string
  update: {
    sessionUpdate: string
    [key: string]: unknown
  }
}

/** A select-style config option as returned in `session/new` results. */
export interface AcpConfigOption {
  id: string
  name: string
  category?: string
  type: string
  currentValue?: string
  options?: Array<{ value: string; name: string; description?: string }>
}

export interface AcpSessionNewResult {
  sessionId: string
  configOptions?: AcpConfigOption[]
}

export interface AcpPromptUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  thoughtTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
}

export interface AcpPromptResult {
  stopReason: string
  usage?: AcpPromptUsage
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean; embeddedContext?: boolean }
    [key: string]: unknown
  }
  agentInfo?: { name?: string; version?: string }
  authMethods?: Array<{ id: string; name: string }>
}

/** JSON-RPC error surfaced from the agent. */
export class AcpRpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'AcpRpcError'
    this.code = code
    this.data = data
  }
}

/** Transport-level failure (process died, write failed, startup failed). */
export class AcpTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AcpTransportError'
  }
}

export interface AcpProcessOptions {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  /** How to answer `session/request_permission` when no handler is wired. */
  permissionPolicy: 'allow' | 'deny'
  /**
   * Async decision hook for `session/request_permission` (e.g. bridging into
   * the harness approval stack). When absent, `permissionPolicy` answers.
   */
  onPermissionRequest?: (params: AcpPermissionRequestParams) => Promise<PermissionDecision>
  logger: (message: string) => void
}

/** One ACP permission option as offered by the agent. */
export interface AcpPermissionOption {
  optionId?: string
  name?: string
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
}

/** `session/request_permission` params. */
export interface AcpPermissionRequestParams {
  sessionId?: string
  toolCall?: {
    toolCallId?: string
    title?: string
    kind?: string
    rawInput?: { command?: string; [key: string]: unknown }
    locations?: Array<{ path?: string }>
  }
  options?: AcpPermissionOption[]
}

/** Client-side decision for a permission request. */
export type PermissionDecision = 'allow' | 'allow_always' | 'deny' | 'cancel'

/**
 * Map a decision onto the agent's offered options. Grants select `allow_once`
 * (never `allow_always` — the harness approves one action at a time); denials
 * select `reject_once`; cancellation reports the cancelled outcome. Pure and
 * exported for tests.
 */
export function permissionOutcome(decision: PermissionDecision, options: AcpPermissionOption[]): Record<string, unknown> {
  if (decision === 'cancel') return { outcome: { outcome: 'cancelled' } }
  const pick = (kinds: string[]) => options.find((o) => o.kind && kinds.includes(o.kind))?.optionId
  const optionId = decision === 'deny'
    ? (pick(['reject_once', 'reject_always']) ?? options[options.length - 1]?.optionId)
    : decision === 'allow_always'
      // Persistent grant: only the danger-full-access session preset derives this.
      ? (pick(['allow_always']) ?? pick(['allow_once']) ?? options[0]?.optionId)
      // Interactive grants are one-shot even when allow_always is offered.
      : (pick(['allow_once']) ?? options.find((o) => o.kind === 'allow_always')?.optionId ?? options[0]?.optionId)
  if (optionId === undefined) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId } }
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const CLIENT_INFO = { name: 'dsh-agent-adapter', version: '0.1.0' }
const PROTOCOL_VERSION = 1
const STARTUP_TIMEOUT_MS = 30_000

/**
 * One long-lived ACP agent process. Lazily spawned on first use, respawned on
 * unexpected exit; every in-flight request is rejected on transport loss so
 * callers can recover at the session layer.
 */
export class AcpProcess {
  private child?: ChildProcess
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private listeners = new Map<string, Set<(update: AcpSessionUpdate['update']) => void>>()
  private capabilities?: AcpInitializeResult
  private starting?: Promise<AcpInitializeResult>
  private disposed = false

  constructor(readonly options: AcpProcessOptions) {}

  /** Agent capabilities captured at initialize; undefined until first start. */
  get agentCapabilities(): AcpInitializeResult | undefined {
    return this.capabilities
  }

  /** Ensure the process is spawned and the initialize handshake has completed. */
  ensureStarted(): Promise<AcpInitializeResult> {
    if (this.disposed) return Promise.reject(new AcpTransportError('acp process is disposed'))
    if (this.capabilities) return Promise.resolve(this.capabilities)
    if (this.starting) return this.starting
    this.starting = this.start()
      .then((caps) => {
        this.capabilities = caps
        return caps
      })
      .finally(() => {
        this.starting = undefined
      })
    return this.starting
  }

  private async start(): Promise<AcpInitializeResult> {
    const { command, args, cwd, env } = this.options
    this.options.logger(`acp: spawning ${command} ${args.join(' ')} (cwd: ${cwd})`)
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
    })
    child.on('error', (error) => {
      this.options.logger(`acp: process error: ${error.message}`)
      this.teardown(new AcpTransportError(`acp agent process failed: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      this.options.logger(`acp: process exited (code=${code}, signal=${signal})`)
      this.teardown(new AcpTransportError(`acp agent process exited (code=${code}, signal=${signal})${stderr ? `: ${stderr.slice(-500)}` : ''}`))
    })

    const rl = readline.createInterface({ input: child.stdout! })
    rl.on('line', (line) => this.onLine(line))

    try {
      const init = await this.requestWithTimeout<AcpInitializeResult>(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: CLIENT_INFO,
        },
        STARTUP_TIMEOUT_MS,
      )
      this.options.logger(`acp: initialized ${init.agentInfo?.name ?? 'agent'} ${init.agentInfo?.version ?? ''}`)
      return init
    } catch (error) {
      this.teardown(error instanceof Error ? error : new AcpTransportError(String(error)))
      throw error
    }
  }

  /** Reject every pending request and forget the dead child. */
  private teardown(cause: Error) {
    const pending = [...this.pending.values()]
    this.pending.clear()
    this.capabilities = undefined
    this.listeners.clear()
    const child = this.child
    this.child = undefined
    for (const entry of pending) entry.reject(cause)
    try { child?.kill('SIGTERM') } catch { /* already gone */ }
  }

  private onLine(line: string) {
    if (!line.trim()) return
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string; data?: unknown } }
    try {
      msg = JSON.parse(line)
    } catch {
      this.options.logger(`acp: ignoring non-JSON line: ${line.slice(0, 200)}`)
      return
    }
    if (msg.method && msg.id !== undefined) {
      this.onAgentRequest(msg.id, msg.method, msg.params ?? {})
      return
    }
    if (msg.method) {
      this.onNotification(msg.method, msg.params ?? {})
      return
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(Number(msg.id))
      if (!entry) return
      this.pending.delete(Number(msg.id))
      if (msg.error) entry.reject(new AcpRpcError(msg.error.code, msg.error.message, msg.error.data))
      else entry.resolve(msg.result)
    }
  }

  /** Agent→client requests: permission prompts go to the async handler (policy fallback); fs/terminal are refused (not advertised). */
  private onAgentRequest(id: number | string, method: string, params: Record<string, unknown>) {
    if (method === 'session/request_permission') {
      const request = params as AcpPermissionRequestParams
      const options = request.options ?? []
      const answer = async (): Promise<Record<string, unknown>> => {
        if (this.options.onPermissionRequest) {
          try {
            return permissionOutcome(await this.options.onPermissionRequest(request), options)
          } catch (error) {
            this.options.logger(`acp: permission handler failed, failing closed: ${error}`)
            return permissionOutcome('deny', options)
          }
        }
        return permissionOutcome(this.options.permissionPolicy === 'allow' ? 'allow' : 'deny', options)
      }
      void answer().then(
        (result) => this.send({ jsonrpc: '2.0', id, result }),
        () => this.send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } }),
      )
      return
    }
    this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `dsh-agent-adapter: client method not supported: ${method}` } })
  }

  private onNotification(method: string, params: Record<string, unknown>) {
    if (method !== 'session/update') return
    const update = params as unknown as AcpSessionUpdate
    const set = this.listeners.get(update.sessionId)
    if (!set) return
    for (const cb of set) {
      try { cb(update.update) } catch (error) { this.options.logger(`acp: session update listener failed: ${error}`) }
    }
  }

  private send(msg: Record<string, unknown>) {
    const child = this.child
    if (!child?.stdin?.writable) return
    child.stdin.write(JSON.stringify(msg) + '\n')
  }

  /** Send a JSON-RPC request and await its result. */
  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.disposed) return Promise.reject(new AcpTransportError('acp process is disposed'))
    if (!this.child) return Promise.reject(new AcpTransportError('acp process is not started'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new AcpTransportError(String(error)))
      }
    })
  }

  private requestWithTimeout<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AcpTransportError(`acp ${method} timed out after ${timeoutMs}ms`)), timeoutMs)
      this.request<T>(method, params).then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error) => { clearTimeout(timer); reject(error) },
      )
    })
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params: Record<string, unknown>) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Subscribe to `session/update` notifications for one ACP session. */
  onSessionUpdate(sessionId: string, cb: (update: AcpSessionUpdate['update']) => void): () => void {
    let set = this.listeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size === 0) this.listeners.delete(sessionId)
    }
  }

  /** Stop the child and reject everything in flight. */
  dispose() {
    this.disposed = true
    this.teardown(new AcpTransportError('acp process disposed'))
  }
}
