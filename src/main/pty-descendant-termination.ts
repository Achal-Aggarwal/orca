import { execFile } from 'node:child_process'
import type { JobTerminationOutcome } from './windows/windows-pty-job'
import { terminateWindowsProcessTree, type WindowsTreeKiller } from './windows-process-tree-kill'
import {
  verifyWindowsTreeKillTarget,
  type WindowsTreeKillTarget
} from './windows-pty-root-identity'
import { parseProcessTable, type ProcessTableRow } from './pty-process-table-parser'
import {
  createProcessTableSnapshotReader,
  readProcessTableBeforeDeadline,
  collectDescendantRows,
  type DescendantSnapshot,
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  type ProcessTableCapture,
  type ProcessTableReader
} from './pty-descendant-snapshot'

export { parseProcessTable, type ProcessTableRow } from './pty-process-table-parser'
export {
  createProcessTableSnapshotReader,
  readProcessTableBeforeDeadline,
  collectDescendantRows,
  type PosixProcessIdentity,
  type DescendantSnapshot,
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  type ProcessTableCapture,
  type ProcessTableReader
} from './pty-descendant-snapshot'

export const DESCENDANT_KILL_GRACE_MS = 2_000

export type SignalSender = (pid: number, signal: NodeJS.Signals) => void

// Busy hosts can exceed execFile’s 1MB default; truncated output would omit descendants.
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

function readFreshProcessTable(
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

export const readProcessTable = createProcessTableSnapshotReader(readFreshProcessTable)

type SnapshotDeps = {
  readTable?: ProcessTableReader
  platform?: NodeJS.Platform
  timeoutMs?: number
}

/** Capture before signalling the root: exited parents’ descendants reparent and become unfindable; failure returns null. */
export async function captureDescendantSnapshot(
  rootPid: number,
  deps: SnapshotDeps = {}
): Promise<DescendantSnapshot | null> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32' || !Number.isInteger(rootPid) || rootPid <= 0) {
    return null
  }
  const readTable = deps.readTable ?? readProcessTable
  const timeoutMs = deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
  // Bound custom readers too; production execFile separately kills wedged ps processes.
  const capture = await readProcessTableBeforeDeadline(readTable, timeoutMs)
  if (!capture) {
    return null
  }
  return collectDescendantRows(rootPid, capture.rows, capture.capturedAtMs)
}

type KillSweepDeps = SnapshotDeps &
  TerminateDeps & {
    ownsRoot?: () => boolean
    authorizeStop?: () => Promise<boolean>
    /** Shutdown can retain the owner until descendant escalation finishes. */
    terminateDescendants?: (snapshot: DescendantSnapshot) => void | Promise<unknown>
    awaitEscalation?: boolean | (() => boolean)
    /** unavailable means no owned job exists, not that the tree exited. */
    terminateOwnedTree?: () => JobTerminationOutcome
    killWindowsTree?: WindowsTreeKiller
    verifyTreeKillTarget?: (rootPid: number) => Promise<WindowsTreeKillTarget>
  }

/** Call before killing the root: POSIX needs live ancestry; Windows prefers an owned job, then an identity-gated PID walk. */
export async function killWithDescendantSweep(
  rootPid: number,
  killRoot: () => void,
  deps: KillSweepDeps = {}
): Promise<void> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    const verify = deps.verifyTreeKillTarget ?? verifyWindowsTreeKillTarget
    const preparedTarget = deps.authorizeStop
      ? await verify(rootPid).catch((): WindowsTreeKillTarget => 'unknown')
      : null
    if (deps.authorizeStop && !(await deps.authorizeStop())) {
      throw new Error('terminal_stop_declined')
    }
    try {
      if ((deps.ownsRoot?.() ?? true) && Number.isInteger(rootPid) && rootPid > 0) {
        // Owned jobs survive PID reuse and include descendants reparented away from the shell.
        if (deps.terminateOwnedTree?.() === 'terminated') {
          return
        }
        // ConPTY closes the shell handle before JS sees exit; require OS identity to reject recycled PIDs.
        const verify = deps.verifyTreeKillTarget ?? verifyWindowsTreeKillTarget
        const target =
          preparedTarget ?? (await verify(rootPid).catch((): WindowsTreeKillTarget => 'unknown'))
        // Re-check ownership: the identity query awaits, so exit can land meanwhile.
        if (target === 'own' && (deps.ownsRoot?.() ?? true)) {
          const killTree =
            deps.killWindowsTree ??
            ((pid: number) => terminateWindowsProcessTree(pid, { site: 'pty-descendant-sweep' }))
          // A taskkill failure must not skip root termination.
          await killTree(rootPid).catch(() => {})
        }
      }
    } finally {
      killRoot()
    }
    return
  }

  const snapshot = await captureDescendantSnapshot(rootPid, deps)
  if (deps.authorizeStop && !(await deps.authorizeStop())) {
    throw new Error('terminal_stop_declined')
  }
  let descendants: void | Promise<unknown> = undefined
  const awaitEscalation =
    typeof deps.awaitEscalation === 'function' ? deps.awaitEscalation() : deps.awaitEscalation
  if (awaitEscalation) {
    try {
      if (snapshot && (deps.ownsRoot?.() ?? true)) {
        descendants = deps.terminateDescendants
          ? deps.terminateDescendants(snapshot)
          : terminateDescendantSnapshot(snapshot, deps)
      }
      await descendants
    } finally {
      killRoot()
    }
    return
  }
  try {
    // Signal descendants before root death creates a reparent/PID-reuse window.
    if (snapshot && (deps.ownsRoot?.() ?? true)) {
      descendants = deps.terminateDescendants
        ? deps.terminateDescendants(snapshot)
        : terminateDescendantSnapshot(snapshot, deps)
    }
  } finally {
    killRoot()
  }
}

export function sendDescendantSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {}
}

export type TerminateDeps = {
  readTable?: ProcessTableReader
  sendSignal?: SignalSender
  graceMs?: number
  timeoutMs?: number
}

export function hasUnambiguousStartIdentity(row: ProcessTableRow, capturedAtMs: number): boolean {
  return hasUnambiguousStartTime(row.startedAt, capturedAtMs)
}

export function hasUnambiguousStartTime(startedAt: string, capturedAtMs: number): boolean {
  const startedAtMs = Date.parse(startedAt)
  if (!Number.isFinite(startedAtMs)) {
    return false
  }
  // lstart cannot distinguish PID reuse within the capture second.
  return startedAtMs < Math.floor(capturedAtMs / 1_000) * 1_000
}

/** Reach detached descendants with SIGTERM, then escalate only survivors whose identity excludes same-second PID reuse. */
export function terminateDescendantSnapshot(
  snapshot: DescendantSnapshot,
  deps: TerminateDeps = {}
): void {
  const sendSignal = deps.sendSignal ?? sendDescendantSignal
  const readTable = deps.readTable ?? readProcessTable
  for (const row of snapshot.descendants) {
    sendSignal(row.pid, 'SIGTERM')
  }
  if (snapshot.descendants.length === 0) {
    return
  }
  const timer = setTimeout(() => {
    void readProcessTableBeforeDeadline(
      readTable,
      deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
    ).then((capture) => {
      if (!capture) {
        return
      }
      const expectedPids = new Set(snapshot.descendants.map((row) => row.pid))
      const liveTargets = new Map<number, ProcessTableRow | null>()
      // Index only the small set of signal targets, not the whole process table.
      for (const live of capture.rows) {
        if (expectedPids.has(live.pid)) {
          // Duplicate PID rows make identity ambiguous, so never escalate them.
          liveTargets.set(live.pid, liveTargets.has(live.pid) ? null : live)
        }
      }
      for (const row of snapshot.descendants) {
        const live = liveTargets.get(row.pid)
        if (
          hasUnambiguousStartIdentity(
            row,
            snapshot.capturedAtMsByPid?.[String(row.pid)] ?? snapshot.capturedAtMs
          ) &&
          live?.startedAt === row.startedAt &&
          live.pgid === row.pgid
        ) {
          sendSignal(row.pid, 'SIGKILL')
        }
      }
    })
  }, deps.graceMs ?? DESCENDANT_KILL_GRACE_MS)
  timer.unref?.()
}
