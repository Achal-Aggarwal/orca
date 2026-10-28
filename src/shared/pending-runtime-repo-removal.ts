import { ScalarFiniteNumber, ScalarNonemptyString } from './scalar-value-schemas'
import { z } from 'zod'

const PendingRuntimeRepoRemovalSchema = z.object({
  environmentId: ScalarNonemptyString,
  repoId: ScalarNonemptyString,
  requestedAt: ScalarFiniteNumber
})

/** A project this desktop removed while its paired server was unreachable; `repo.rm` replays on reconnect. */
export type PendingRuntimeRepoRemoval = z.infer<typeof PendingRuntimeRepoRemovalSchema>

/** Persisted UI state is hand-editable and older builds never wrote it; keep only well-formed records. */
export function normalizePendingRuntimeRepoRemovals(value: unknown): PendingRuntimeRepoRemoval[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry: unknown) => {
    const parsed = PendingRuntimeRepoRemovalSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}
