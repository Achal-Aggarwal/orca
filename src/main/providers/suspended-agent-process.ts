import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { selectForegroundProcessCandidate } from '../../shared/foreground-process-selection'
import { resolveOuterWrapperForegroundProcess } from '../../shared/foreground-wrapper-agent'

/** Observation only: stopped jobs remain owned work, but never authorize foreground input routing. */
export function resolveSuspendedAgentProcessFromPs(
  rows: readonly ProcessTableRow[],
  shellPid: number
): string | null {
  const descendants = collectDescendantsFromIndex(getProcessTableIndex(rows), shellPid)
  const stopped = descendants.filter((row) => /^[Tt]/.test(row.stat))
  const selected = selectForegroundProcessCandidate(stopped, descendants)
  return selected
    ? resolveOuterWrapperForegroundProcess(selected.recognized, selected.candidate, descendants)
    : null
}
