/**
 * Durable DSH↔ACP session mapping. One JSON document, written atomically
 * (tmp + rename) on every mutation; corruption falls back to empty so a bad
 * file never blocks session creation — affected sessions just re-establish.
 *
 * @module dsh-agent-adapter/acp/store
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Persisted state for one DSH session's ACP counterpart. */
export interface StoredAcpSession {
  /** ACP-side session id returned by `session/new`. */
  acpSessionId: string
  /** Working directory the ACP session was created with (required by `session/load`). */
  cwd: string
  /** ACP model id currently selected on the session, when known. */
  model?: string
  /** Reasoning effort currently selected on the session, when the model exposes one. */
  effort?: string
  /** Text fingerprints of user turns already delivered to the agent, in order. */
  sentUserTurns: string[]
  /** Context size learned from `usage_update` notifications, when seen. */
  contextWindow?: number
}

export class AcpSessionStore {
  private data: Record<string, Record<string, StoredAcpSession>> = {}
  private loaded = false

  constructor(readonly file: string, private readonly logger: (message: string) => void) {}

  private ensureLoaded() {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as Record<string, Record<string, StoredAcpSession>>
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger(`acp: ignoring unreadable session store ${this.file}: ${error}`)
      }
    }
  }

  private persist() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      renameSync(tmp, this.file)
    } catch (error) {
      this.logger(`acp: failed to persist session store ${this.file}: ${error}`)
    }
  }

  get(route: string, dshSessionId: string): StoredAcpSession | undefined {
    this.ensureLoaded()
    return this.data[route]?.[dshSessionId]
  }

  set(route: string, dshSessionId: string, session: StoredAcpSession) {
    this.ensureLoaded()
    ;(this.data[route] ??= {})[dshSessionId] = session
    this.persist()
  }

  /** Forget every stored session of one route (profile removed). */
  deleteRoute(route: string) {
    this.ensureLoaded()
    if (delete this.data[route]) this.persist()
  }
}
