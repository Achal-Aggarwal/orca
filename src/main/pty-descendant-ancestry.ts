import type { DescendantSnapshot } from './pty-descendant-termination'
import type { ProcessTableRow } from './pty-process-table-parser'

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
