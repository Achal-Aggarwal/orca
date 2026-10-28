import {
  ScalarNonemptyString,
  ScalarNullableNumber,
  ScalarNullableString,
  ScalarOptionalString,
  ScalarString,
  ScalarUnknown
} from '../../../shared/scalar-value-schemas'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type Database from '../../sqlite/sync-database'
import { readAgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'

export const commandReceiptScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('caller'), callerKey: ScalarNonemptyString })
])

export type CommandReceiptScope = z.infer<typeof commandReceiptScopeSchema>

/** Sends deduplicate across callers; other receipts remain authenticated-caller scoped. */
export function commandReceiptScope(
  callerKey: string,
  operationIdScope?: 'global'
): CommandReceiptScope {
  return operationIdScope === 'global' ? { kind: 'global' } : { kind: 'caller', callerKey }
}

// Missing referenced rows never authorize rerunning spent commands; replay remaining facts or answer unknown.
export const commandReceiptResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('journal-row'),
    epoch: ScalarNonemptyString,
    sequence: z.int().positive()
  }),
  z.strictObject({
    kind: z.literal('queued-draft'),
    messageId: ScalarNonemptyString
  }),
  // Persist accepted prompt answers so rewinds/revisions cannot change their replay.
  z.strictObject({
    kind: z.literal('prompt-answer'),
    itemId: ScalarNonemptyString,
    revision: z.int().positive(),
    resolution: z.strictObject({
      state: z.literal('resolved'),
      selectedOptionId: ScalarNullableString,
      answers: z
        .array(
          z.strictObject({
            questionId: ScalarString,
            optionIds: z.array(ScalarString),
            other: ScalarOptionalString
          })
        )
        .optional(),
      resolvedBy: ScalarNullableString,
      resolvedAt: ScalarNullableNumber
    })
  }),
  z.strictObject({ kind: z.literal('stop') }),
  z.strictObject({
    kind: z.literal('no-op'),
    outcome: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('cancel'),
        cancelled: z.literal(false),
        turnId: ScalarOptionalString
      }),
      z.strictObject({ kind: z.literal('queue-resume'), resumed: z.literal(false) }),
      z.strictObject({
        kind: z.literal('queue-move'),
        messageId: ScalarNonemptyString.max(512),
        status: z.enum(['moved', 'unchanged', 'gone', 'stale'])
      }),
      z.strictObject({
        kind: z.literal('queue-delete'),
        messageId: ScalarNonemptyString,
        disposition: z.enum(['dispatched', 'withdrawn', 'missing'])
      })
    ])
  })
])

export type CommandReceiptResult = z.infer<typeof commandReceiptResultSchema>

const rejectionSchema = z
  .strictObject({ reference: ScalarUnknown, message: ScalarOptionalString })
  .transform((value, ctx) => {
    const reference = readAgentSessionRefusalReference(value.reference)
    if (!reference || !isDeepStrictEqual(reference, value.reference)) {
      ctx.addIssue({ code: 'custom', message: 'unreadable command refusal' })
      return z.NEVER
    }
    return { reference, ...(value.message !== undefined ? { message: value.message } : {}) }
  })

const receiptIdentity = {
  operationId: ScalarNonemptyString,
  sessionId: ScalarNonemptyString,
  callerKey: ScalarNonemptyString,
  method: ScalarNonemptyString,
  fingerprint: ScalarNonemptyString,
  acceptedAt: z.int().nonnegative()
}

export const commandReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...receiptIdentity,
    status: z.literal('accepted'),
    result: commandReceiptResultSchema
  }),
  z.strictObject({
    ...receiptIdentity,
    status: z.literal('rejected'),
    rejection: rejectionSchema
  })
])

export type CommandReceipt = z.infer<typeof commandReceiptSchema>

// Additive tables preserve older clients' database write compatibility.
export function ensureCommandReceiptsTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_session_command_receipts (
  operation_id  TEXT    NOT NULL,
  session_id    TEXT    NOT NULL REFERENCES agent_session_records(session_id) ON DELETE CASCADE,
  caller_key    TEXT    NOT NULL,
  method        TEXT    NOT NULL,
  fingerprint   TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  result_json   TEXT,
  rejection_json TEXT,
  accepted_at   INTEGER NOT NULL,
  PRIMARY KEY (operation_id, caller_key)
);
CREATE INDEX IF NOT EXISTS agent_session_command_receipts_session
  ON agent_session_command_receipts (session_id);
`)
}
