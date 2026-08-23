/**
 * codex app-server stdio client: one child process speaking newline-delimited
 * JSON-RPC 2.0 (the `"jsonrpc"` header is omitted on the wire, per the
 * app-server protocol), with the server-initiated request surface (approvals,
 * permissions, user input, elicitations) answered per the configured
 * permission policy, and per-thread notification dispatch.
 *
 * Protocol reference: codex-rs/app-server/README.md. The wire shapes used here
 * were verified against `codex app-server generate-ts` output for codex-cli
 * 0.148.0.
 *
 * @module dsh-agent-adapter/codex/client
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as readline from 'node:readline'

/** One user-input item inside a `turn/start` request. */
export interface CodexInputItem {
  type: string
  text?: string
  url?: string
  path?: string
  [key: string]: unknown
}

/** A codex ThreadItem (tagged union); only the fields we read are typed. */
export interface CodexThreadItem {
  type: string
  id: string
  text?: string
  phase?: string
  summary?: string[]
  content?: Array<{ type: string; text?: string }>
  command?: string
  cwd?: string
  status?: string
  exitCode?: number | null
  durationMs?: number | null
  aggregatedOutput?: string
  changes?: Array<{ path: string; kind: string; diff?: string }>
  server?: string
  tool?: string
  query?: string
  review?: string
  [key: string]: unknown
}

export interface CodexTurn {
  id: string
  status: string
  error?: { message: string; codexErrorInfo?: unknown; additionalDetails?: string | null } | null
  items?: CodexThreadItem[]
}

export interface CodexThread {
  id: string
  ephemeral?: boolean
  modelProvider?: string
  status?: { type: string }
  [key: string]: unknown
}

export interface CodexTokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface CodexThreadTokenUsage {
  total: CodexTokenUsageBreakdown
  last: CodexTokenUsageBreakdown
  modelContextWindow: number | null
}

/** A `model/list` catalog entry. */
export interface CodexModel {
  id: string
  model: string
  displayName: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>
  inputModalities?: string[]
}

export interface CodexInitializeResult {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
}

/** A server notification relevant to turn streaming. */
export interface CodexNotification {
  method: string
  params: Record<string, unknown>
}

/** JSON-RPC error surfaced from the app-server. */
export class CodexRpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'CodexRpcError'
    this.code = code
    this.data = data
  }
}

/** Transport-level failure (process died, write failed, startup failed). */
export class CodexTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CodexTransportError'
  }
}

/** One approval request codex asked the client to decide. */
export interface CodexApprovalRequest {
  kind: 'command' | 'fileChange' | 'permission'
  threadId?: string
  turnId?: string
  itemId?: string
  command?: string
  cwd?: string
  reason?: string
  /** Requested permission profile (kind === 'permission'). */
  permissions?: unknown
}

/** The decision a bridge returns; mapped onto the codex decision vocabulary. */
export type CodexApprovalDecision = 'accept' | 'decline' | 'cancel'

export interface CodexProcessOptions {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  /**
   * Approval bridge: every codex approval / permission request is forwarded
   * here (the DSH approval service in production). Missing, throwing, or an
   * undefined return fails closed — the request is declined.
   */
  onApproval?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision | undefined>
  logger: (message: string) => void
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const CLIENT_INFO = { name: 'dsh_agent_adapter', title: 'DSH agent adapter (codex half)', version: '0.1.0' }
const STARTUP_TIMEOUT_MS = 30_000

/**
 * One long-lived `codex app-server` process. Lazily spawned on first use,
 * respawned on unexpected exit; every in-flight request is rejected on
 * transport loss so callers can recover at the thread layer.
 */
export class CodexProcess {
  private child?: ChildProcess
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  /** Thread-scoped notification listeners, keyed by threadId. */
  private listeners = new Map<string, Set<(notification: CodexNotification) => void>>()
  private initialized = false
  private starting?: Promise<CodexInitializeResult>
  private disposed = false

  constructor(readonly options: CodexProcessOptions) {}

  /** Ensure the process is spawned and the initialize handshake has completed. */
  ensureStarted(): Promise<CodexInitializeResult> {
    if (this.disposed) return Promise.reject(new CodexTransportError('codex process is disposed'))
    if (this.initialized) {
      return Promise.resolve({
        userAgent: '', codexHome: '', platformFamily: '', platformOs: '',
      })
    }
    if (this.starting) return this.starting
    this.starting = this.start()
      .then((info) => {
        this.initialized = true
        return info
      })
      .finally(() => {
        this.starting = undefined
      })
    return this.starting
  }

  private async start(): Promise<CodexInitializeResult> {
    const { command, args, cwd, env } = this.options
    this.options.logger(`codex: spawning ${command} ${args.join(' ')} (cwd: ${cwd})`)
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
      this.options.logger(`codex: process error: ${error.message}`)
      this.teardown(new CodexTransportError(`codex app-server process failed: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      this.options.logger(`codex: process exited (code=${code}, signal=${signal})`)
      this.teardown(new CodexTransportError(`codex app-server process exited (code=${code}, signal=${signal})${stderr ? `: ${stderr.slice(-500)}` : ''}`))
    })

    const rl = readline.createInterface({ input: child.stdout! })
    rl.on('line', (line) => this.onLine(line))

    try {
      const init = await this.requestWithTimeout<CodexInitializeResult>(
        'initialize',
        {
          clientInfo: CLIENT_INFO,
          capabilities: {
            // Enables excludeTurns on thread/resume and other opt-in surfaces.
            experimentalApi: true,
          },
        },
        STARTUP_TIMEOUT_MS,
      )
      // The handshake completes with the `initialized` notification; any
      // request sent before it is rejected by the server.
      this.notify('initialized', {})
      this.options.logger(`codex: initialized (${init.userAgent})`)
      return init
    } catch (error) {
      this.teardown(error instanceof Error ? error : new CodexTransportError(String(error)))
      throw error
    }
  }

  /** Reject every pending request and forget the dead child. */
  private teardown(cause: Error) {
    const pending = [...this.pending.values()]
    this.pending.clear()
    this.initialized = false
    const listeners = [...this.listeners.values()]
    this.listeners.clear()
    const child = this.child
    this.child = undefined
    for (const entry of pending) entry.reject(cause)
    for (const set of listeners) {
      for (const cb of set) {
        try { cb({ method: 'transport/lost', params: { message: cause.message } }) } catch { /* listener failure is secondary */ }
      }
    }
    try { child?.kill('SIGTERM') } catch { /* already gone */ }
  }

  private onLine(line: string) {
    if (!line.trim()) return
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string; data?: unknown } }
    try {
      msg = JSON.parse(line)
    } catch {
      this.options.logger(`codex: ignoring non-JSON line: ${line.slice(0, 200)}`)
      return
    }
    if (msg.method && msg.id !== undefined) {
      this.onServerRequest(msg.id, msg.method, msg.params ?? {})
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
      if (msg.error) entry.reject(new CodexRpcError(msg.error.code, msg.error.message, msg.error.data))
      else entry.resolve(msg.result)
    }
  }

  /**
   * Server→client requests: every approval / permission prompt is forwarded
   * to the onApproval bridge (fail-closed); user-input and elicitation
   * prompts are declined (there is no interactive user on this side);
   * everything else is refused.
   */
  private onServerRequest(id: number | string, method: string, params: Record<string, unknown>) {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval': {
        const request: CodexApprovalRequest = {
          kind: method === 'item/commandExecution/requestApproval'
            ? 'command'
            : method === 'item/fileChange/requestApproval'
              ? 'fileChange'
              : 'permission',
          ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
          ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
          ...(typeof params.itemId === 'string' ? { itemId: params.itemId } : {}),
          ...(typeof params.command === 'string' ? { command: params.command } : {}),
          ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
          ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
          ...(method === 'item/permissions/requestApproval' ? { permissions: params.permissions } : {}),
        }
        void this.answerBridged(id, request)
        return
      }
      case 'item/tool/requestUserInput': {
        // No interactive user here: answer every question with empty input.
        this.send({ id, result: { answers: {} } })
        return
      }
      case 'mcpServer/elicitation/request': {
        this.send({ id, result: { action: 'decline', content: null } })
        return
      }
      case 'currentTime/read': {
        this.send({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } })
        return
      }
      default:
        this.send({ id, error: { code: -32601, message: `dsh-agent-adapter: client method not supported: ${method}` } })
    }
  }

  /** Bridge one approval request to the DSH approval service; fail closed. */
  private async answerBridged(id: number | string, request: CodexApprovalRequest) {
    let decision: CodexApprovalDecision = 'decline'
    try {
      decision = (await this.options.onApproval?.(request)) ?? 'decline'
    } catch (error) {
      this.options.logger(`codex: bridged approval failed, declining: ${error}`)
    }
    if (request.kind === 'permission') {
      // Permission requests answer with the granted subset, not a decision.
      this.send({
        id,
        result: decision === 'accept'
          ? { scope: 'turn', permissions: request.permissions ?? {} }
          : { permissions: {} },
      })
      return
    }
    this.send({ id, result: { decision } })
  }

  private onNotification(method: string, params: Record<string, unknown>) {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    if (!threadId) return
    const set = this.listeners.get(threadId)
    if (!set) return
    const notification: CodexNotification = { method, params }
    for (const cb of set) {
      try { cb(notification) } catch (error) { this.options.logger(`codex: notification listener failed: ${error}`) }
    }
  }

  private send(msg: Record<string, unknown>) {
    const child = this.child
    if (!child?.stdin?.writable) return
    child.stdin.write(JSON.stringify(msg) + '\n')
  }

  /** Send a JSON-RPC request and await its result. */
  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.disposed) return Promise.reject(new CodexTransportError('codex process is disposed'))
    if (!this.child) return Promise.reject(new CodexTransportError('codex process is not started'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject })
      try {
        this.send({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new CodexTransportError(String(error)))
      }
    })
  }

  private requestWithTimeout<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CodexTransportError(`codex ${method} timed out after ${timeoutMs}ms`)), timeoutMs)
      this.request<T>(method, params).then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error) => { clearTimeout(timer); reject(error) },
      )
    })
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params: Record<string, unknown>) {
    this.send({ method, params })
  }

  /** Subscribe to notifications carrying the given threadId. */
  onThreadNotification(threadId: string, cb: (notification: CodexNotification) => void): () => void {
    let set = this.listeners.get(threadId)
    if (!set) {
      set = new Set()
      this.listeners.set(threadId, set)
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size === 0) this.listeners.delete(threadId)
    }
  }

  /** Stop the child and reject everything in flight. */
  dispose() {
    this.disposed = true
    this.teardown(new CodexTransportError('codex process disposed'))
  }
}
