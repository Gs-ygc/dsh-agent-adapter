/**
 * Shared local-agent detection for both adapter halves. Probes a command with
 * `--version` and reads the first line of its output; PATH misses and timeouts
 * read as absent. Extracted from the ACP half's known-agent scanner so the
 * codex half reuses the exact same probe.
 *
 * @module dsh-agent-adapter/detect
 */
import { spawn } from 'node:child_process'

export interface AgentDetection {
  detected: boolean
  /** First line of `--version` output when the probe produced one. */
  version?: string
}

const PROBE_TIMEOUT_MS = 4000

/** Probe one command with `--version`; PATH misses and timeouts read as absent. */
export function detectAgent(command: string): Promise<AgentDetection> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (detection: AgentDetection) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      resolve(detection)
    }
    let out = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ detected: false })
      return
    }
    const timer = setTimeout(() => finish(out.trim() ? { detected: true, version: firstLine(out) } : { detected: false }), PROBE_TIMEOUT_MS)
    child.on('error', () => finish({ detected: false }))
    child.stdout?.on('data', (chunk) => { out += String(chunk) })
    child.stderr?.on('data', (chunk) => { out += String(chunk) })
    child.on('close', (code) => {
      const version = firstLine(out)
      finish(code === 0 || version !== undefined ? { detected: true, ...(version ? { version } : {}) } : { detected: false })
    })
  })
}

function firstLine(text: string): string | undefined {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return line?.slice(0, 80)
}
