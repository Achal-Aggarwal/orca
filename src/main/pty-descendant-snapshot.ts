import type { ProcessTableRow } from './pty-process-table-parser'

export const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000

export type ProcessTableCapture = {
  rows: ProcessTableRow[]
  /** Start boundary of the scan that produced rows, never a later consumer's time. */
  capturedAtMs: number
}

export type ProcessTableReader = (timeoutMs?: number) => Promise<ProcessTableCapture>

export type PosixProcessIdentity = Pick<ProcessTableRow, 'pid' | 'startedAt'>

export type DescendantSnapshot = {
  root?: PosixProcessIdentity
  rootPgid: number | null
  descendants: ProcessTableRow[]
  /** Wall-clock boundary for an unmerged snapshot (or legacy callers). */
  capturedAtMs: number
  /** Per-PID identity boundaries for merged captures. */
  capturedAtMsByPid?: Readonly<Record<string, number>>
  /** Fresh ancestry proves ownership despite lstart’s second-resolution timestamps; retained merge rows do not. */
  reDerivedPids?: ReadonlySet<number>
}

/** Share only scans not yet started; later requests need fresh identities before signalling. */
export function createProcessTableSnapshotReader(
  readFresh: ProcessTableReader
): ProcessTableReader {
  let queued: { promise: Promise<ProcessTableCapture>; started: boolean } | null = null

  return (timeoutMs) => {
    if (queued && !queued.started) {
      return queued.promise
    }

    const entry: { promise: Promise<ProcessTableCapture>; started: boolean } = {
      promise: Promise.resolve(undefined as never),
      started: false
    }
    entry.promise = Promise.resolve().then(() => {
      // Start each later request’s scan within its own deadline, without queuing behind an older one.
      entry.started = true
      return readFresh(timeoutMs)
    })
    queued = entry
    const clearQueued = (): void => {
      if (queued === entry) {
        queued = null
      }
    }
    void entry.promise.then(clearQueued, clearQueued)
    return entry.promise
  }
}

export function readProcessTableBeforeDeadline(
  readTable: ProcessTableReader,
  timeoutMs: number
): Promise<ProcessTableCapture | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (capture: ProcessTableCapture | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(capture)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    try {
      void readTable(timeoutMs).then(
        (rows) => finish(rows),
        () => finish(null)
      )
    } catch {
      finish(null)
    }
  })
}

export function collectDescendantRows(
  rootPid: number,
  table: ProcessTableRow[],
  capturedAtMs = Date.now()
): DescendantSnapshot {
  const childrenByPpid = new Map<number, ProcessTableRow[]>()
  let rootRow: ProcessTableRow | null = null
  let duplicateRoot = false
  for (const row of table) {
    if (row.pid === rootPid) {
      // Duplicate root rows from a non-atomic read leave its identity ambiguous.
      duplicateRoot = rootRow !== null
      rootRow ??= row
      continue
    }
    const siblings = childrenByPpid.get(row.ppid)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByPpid.set(row.ppid, [row])
    }
  }
  // After root exit, descendants reparent; remaining rows with its old PID as parent may reflect PID reuse.
  if (!rootRow || duplicateRoot) {
    return { rootPgid: null, descendants: [], capturedAtMs }
  }
  const descendants: ProcessTableRow[] = []
  const queue = [rootPid]
  const visited = new Set(queue)
  for (let nextIndex = 0; nextIndex < queue.length; nextIndex += 1) {
    const pid = queue[nextIndex]
    for (const child of childrenByPpid.get(pid) ?? []) {
      // Non-atomic ps output can contain duplicate or cyclic rows; never loop on them.
      if (visited.has(child.pid)) {
        continue
      }
      visited.add(child.pid)
      descendants.push(child)
      queue.push(child.pid)
    }
  }
  return {
    root: { pid: rootRow.pid, startedAt: rootRow.startedAt },
    rootPgid: rootRow.pgid,
    descendants,
    capturedAtMs,
    reDerivedPids: new Set(descendants.map((row) => row.pid))
  }
}
