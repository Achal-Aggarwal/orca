import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { projectLocalWorkerFleet } from './worker/worker-list-projection'

// A receipt carries `next` only where stopping is the right move; without it, act on the receipt.
const AWAIT_WORKER_REPORTS =
  'Orca wakes you when a worker reports. Once every worker you need is started, end your turn. Do not poll.'
export const WORKER_DONE_RECORDED_NEXT = 'Recorded. End your turn.'

const ReadyWorkerStart = z.looseObject({
  state: z.literal('ready'),
  workerOutcome: z.never().optional()
})

const EmptyRunCheck = z.looseObject({
  runId: z.string(),
  count: z.literal(0),
  cancelled: z.literal(false).optional(),
  waitInterrupted: z.never().optional()
})

/** A worker that already reported left mail to act on, so only an unreported start says to stop. */
export function withWorkerStartNext(receipt: unknown): unknown {
  const ready = ReadyWorkerStart.safeParse(receipt)
  return ready.success ? { ...ready.data, next: AWAIT_WORKER_REPORTS } : receipt
}

/** Stop only while a worker still runs and worker-list owes no action for any of them. */
export async function withRunCheckNext(
  runtime: OrcaRuntimeService,
  result: unknown
): Promise<unknown> {
  const empty = EmptyRunCheck.safeParse(result)
  if (!empty.success) {
    return result
  }
  const rows = runtime.getOrchestrationDb().listWorkerTerminalResources({ runId: empty.data.runId })
  const { workers } = await projectLocalWorkerFleet(runtime, rows, {
    limit: rows.length,
    completeProjection: true
  })
  const awaiting =
    workers.some((worker) => worker.outcome === 'in_progress') &&
    workers.every((worker) => worker.nextAction.kind === 'none')
  return awaiting ? { ...empty.data, next: AWAIT_WORKER_REPORTS } : result
}
