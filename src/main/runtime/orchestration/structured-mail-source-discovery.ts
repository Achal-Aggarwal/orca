import { z } from 'zod'
import type { OrchestrationDb } from './db'
import type { MailCreationHistory } from './structured-mail-creation-history'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
export type MailAdmission = { owner: object; generation: string; queuedBytes: number }
export const sourceIdentity = z.object({
  id: z.string(),
  run_id: z.string(),
  sequence: z.number(),
  type: z.string(),
  to_handle: z.string(),
  read: z.number(),
  delivered_at: z.string().nullable(),
  pointer_enter_pending: z.number(),
  delivery_contract: z.string(),
  ordering_origin: z.enum(['local', 'imported']).nullable()
})
export type SourceIdentity = z.infer<typeof sourceIdentity>
export const SOURCE_COLUMNS = `id, run_id, sequence, type, to_handle, read, delivered_at,
  pointer_enter_pending, delivery_contract, ordering_origin`
export type Debt = 'capacity' | 'check' | 'unknown' | 'stable' | 'retry' | 'stamp'
export type Interest = {
  db: OrchestrationDb
  target: StructuredPointerTarget
  authority: MailAdmission
  frontier: number
  deferred: Map<string, { sequence: number; reason: Debt }>
  /** Only genuinely generated local insertions observed before any possible offer. */
  newSources: Set<string>
  history?: MailCreationHistory
  running: boolean
  pending: boolean
  consumersChanged: boolean
  capacityImproved: boolean
  retry: boolean
}

/** One finite metadata pass; creation and lifecycle remain with the existing adapter/queue. */
export async function discoverMailSources(input: {
  mailbox: string
  interest: Interest
  current: () => boolean
  admission: () => MailAdmission | null
  offer: (source: SourceIdentity) => Promise<void>
  retire: (id: string) => void
  finished: () => void
}): Promise<void> {
  const { mailbox, interest, current, admission, offer, retire, finished } = input
  while (interest.pending && current()) {
    interest.pending = false
    const now = admission()
    if (!now) {
      return
    }
    const improved = interest.capacityImproved || now.queuedBytes < interest.authority.queuedBytes
    interest.capacityImproved = false
    const consumersChanged = interest.consumersChanged
    const retry = interest.retry
    interest.consumersChanged = false
    interest.retry = false
    interest.authority = now
    const deferred =
      improved || consumersChanged || retry
        ? [...interest.deferred].sort((a, b) => a[1].sequence - b[1].sequence)
        : []
    for (const [id, debt] of deferred) {
      if (
        (debt.reason === 'capacity' && improved) ||
        (debt.reason === 'check' && consumersChanged) ||
        ((debt.reason === 'retry' || debt.reason === 'stamp') && retry)
      ) {
        const raw = interest.db.db
          .prepare(`SELECT ${SOURCE_COLUMNS} FROM messages WHERE id = ?`)
          .get(id)
        if (!raw) {
          retire(id)
        } else {
          await offer(sourceIdentity.parse(raw))
        }
        if (!current()) {
          return
        }
      }
    }
    const through = Number(
      interest.db.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS high FROM messages').get()
        ?.high ?? 0
    )
    while (interest.frontier < through && current()) {
      const rows = interest.db.db
        .prepare(`SELECT ${SOURCE_COLUMNS} FROM messages
          WHERE to_handle = ? AND delivered_at IS NULL AND sequence > ? AND sequence <= ?
          ORDER BY sequence LIMIT 50`)
        .all(mailbox, interest.frontier, through)
      if (rows.length === 0) {
        interest.frontier = through
        break
      }
      for (const raw of rows) {
        const source = sourceIdentity.parse(raw)
        await offer(source)
        interest.frontier = source.sequence
        if (!current()) {
          return
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const capacity = admission()
    if (capacity) {
      // Our own inserts reduce capacity, never an improvement that replays refused debt.
      interest.authority = capacity
    }
    if (
      !interest.pending &&
      interest.deferred.size === 0 &&
      interest.newSources.size === 0 &&
      current()
    ) {
      finished()
    }
  }
}
