import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { JournalRow } from './journal-row-schema'
import type { MailHoldFacts } from './journal-mail-holds'

const scopeSchema = z.object({ aliases: z.array(z.string()), root: z.string().nullable() })
const cutSchema = z.object({
  incarnation: z.string().min(1),
  throughSequence: z.int().nonnegative(),
  direct: z.array(z.string()),
  runs: z.array(z.string()),
  dispatches: z.array(z.string())
})
const boundarySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('released'), scope: scopeSchema.optional() }),
  z.object({
    status: z.literal('held'),
    scope: scopeSchema.optional(),
    stop: z.object({ sessionId: z.string(), epoch: z.string(), sequence: z.int() }).nullable(),
    cuts: z.array(cutSchema),
    members: z.array(z.string()),
    ambiguous: z.boolean()
  })
])
const sourceSchema = z.object({
  incarnation: z.string().min(1),
  mailbox: z.string(),
  members: z
    .array(
      z.object({
        id: z.string(),
        sequence: z.int().positive(),
        origin: z.enum(['local', 'imported']).nullable()
      })
    )
    .min(1)
})

export type JournalMailBoundary = z.infer<typeof boundarySchema>
export type JournalMailCut = z.infer<typeof cutSchema>
export type JournalMailSource = z.infer<typeof sourceSchema>

export function readJournalMailBoundary(value: unknown): JournalMailBoundary | undefined {
  const parsed = boundarySchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
export function readJournalMailSource(value: unknown): JournalMailSource | undefined {
  const parsed = sourceSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
export function unknownJournalMailBoundary(): JournalMailBoundary {
  return { status: 'held', stop: null, cuts: [], members: [], ambiguous: true }
}

/** Source order never comes from timestamps or the receiving order of imported messages. */
export function journalMailSourceEligible(
  boundary: JournalMailBoundary | undefined,
  source: JournalMailSource | undefined
): boolean {
  if (boundary?.status === 'released') {
    return true
  }
  if (!boundary || !source) {
    return false
  }
  const cut = boundary.cuts.find(
    (candidate) =>
      candidate.incarnation === source.incarnation &&
      (candidate.direct.includes(source.mailbox) ||
        (source.mailbox.startsWith('run:') && candidate.runs.includes(source.mailbox.slice(4))) ||
        (source.mailbox.startsWith('dispatch:') &&
          candidate.dispatches.includes(source.mailbox.slice(9))))
  )
  return Boolean(
    cut &&
    source.members.every(
      (member) =>
        member.origin === 'local' &&
        member.sequence > cut.throughSequence &&
        !boundary.members.includes(member.id)
    )
  )
}

const factMemos = new WeakMap<JournalMailBoundary, MailHoldFacts>()

export function journalMailHoldFacts(boundary: JournalMailBoundary | undefined): MailHoldFacts {
  const value = boundary ?? unknownJournalMailBoundary()
  const memo = factMemos.get(value)
  if (memo) {
    return memo
  }
  const facts: MailHoldFacts = {
    held: value.status === 'held',
    ...(value.scope ? { scope: value.scope } : {}),
    members: new Set(value.status === 'held' ? value.members : []),
    ambiguous: value.status === 'held' && value.ambiguous,
    key: createHash('sha256').update(JSON.stringify(value)).digest('hex')
  }
  factMemos.set(value, facts)
  return facts
}

export function foldJournalMailBoundary(
  prior: JournalMailBoundary | undefined,
  row: JournalRow
): JournalMailBoundary | undefined {
  const stated = readJournalMailBoundary(row.mailBoundary)
  if (stated) {
    return stated
  }
  if (row.kind === 'tombstone') {
    if (row.stopEvent?.reason === 'user-stop') {
      return unknownJournalMailBoundary()
    }
    if (row.queueResume === true) {
      return { status: 'released', ...(prior?.scope ? { scope: prior.scope } : {}) }
    }
  }
  if (
    (row.kind === 'submission' && row.source?.kind === 'user') ||
    (row.kind === 'queue' && row.change.op === 'queued' && !row.change.body.from)
  ) {
    return { status: 'released', ...(prior?.scope ? { scope: prior.scope } : {}) }
  }
  return prior
}
