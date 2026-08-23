/**
 * Durable DSH↔codex thread mapping. One JSON document, written atomically
 * (tmp + rename) on every mutation; corruption falls back to empty so a bad
 * file never blocks session creation — affected sessions just re-establish.
 *
 * @module dsh-agent-adapter/codex/store
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Persisted state for one DSH session's codex counterpart. */
export interface StoredCodexSession {
  /** codex thread id returned by `thread/start`. */
  threadId: string
  /** Working directory the thread was created with. */
  cwd: string
  /** codex model id currently selected on the thread, when known. */
  model?: string
  /** Text fingerprints of user turns already delivered to codex, in order. */
  sentUserTurns: string[]
  /** Context size learned from `thread/tokenUsage/updated`, when seen. */
  contextWindow?: number
}

export class CodexSessionStore {
  private data: Record<string, Record<string, StoredCodexSession>> = {}
  private loaded = false

  constructor(readonly file: string, private readonly logger: (message: string) => void) {}

  private ensureLoaded() {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as Record<string, Record<string, StoredCodexSession>>
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger(`codex: ignoring unreadable session store ${this.file}: ${error}`)
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
      this.logger(`codex: failed to persist session store ${this.file}: ${error}`)
    }
  }

  get(route: string, dshSessionId: string): StoredCodexSession | undefined {
    this.ensureLoaded()
    return this.data[route]?.[dshSessionId]
  }

  set(route: string, dshSessionId: string, session: StoredCodexSession) {
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
