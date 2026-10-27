import { execFile } from 'node:child_process'
import { parseProcessTable, type ProcessTableRow } from './pty-process-table-parser'

export const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000
// Busy hosts can exceed execFile’s 1MB default; truncated output would omit descendants.
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

export type ProcessTableCapture = {
  rows: ProcessTableRow[]
  /** Start boundary of the scan that produced rows, never a later consumer's time. */
  capturedAtMs: number
}

export type ProcessTableReader = (timeoutMs?: number) => Promise<ProcessTableCapture>
export function readFreshProcessTable(
  timeoutMs = DESCENDANT_SNAPSHOT_TIMEOUT_MS
): Promise<ProcessTableCapture> {
  // Stamp before ps starts so a capture-second PID cannot appear older after a clock rollover.
  const capturedAtMs = Date.now()
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,tpgid=,lstart='],
      {
        maxBuffer: PS_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        // Pin lstart’s locale so delayed identity checks parse it consistently.
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ rows: parseProcessTable(stdout), capturedAtMs })
      }
    )
  })
}
