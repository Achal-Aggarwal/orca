import {
  ScalarNonemptyString,
  ScalarNullableNumber,
  ScalarNullableString,
  ScalarNumber,
  ScalarOptionalNonemptyString,
  ScalarOptionalNumber,
  ScalarString
} from './scalar-value-schemas'
// Deep-validate dispatch submissions with open string vocabularies, as in agent-session-journal-schemas.ts.

import { z } from 'zod'
import { AgentJournalAnsweredTurnSchema } from './agent-session-answered-turn-schema'
import { AgentSessionFailureFactSchema } from './agent-session-failure-fact-schema'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import { AgentSessionExecutionOptionsSchema } from './agent-session-execution-options'

// Every persisted field is listed, or a parse strips it: this schema drops unknown keys.
export const AgentJournalSubmissionSchema = z.object({
  clientMessageId: ScalarNonemptyString,
  fence: ScalarNumber.int(),
  payloadFingerprint: ScalarString,
  dispatchState: ScalarNonemptyString,
  providerItemId: ScalarNullableString,
  reason: ScalarNullableString,
  submittedAt: ScalarNumber,
  resolvedAt: ScalarNullableNumber,
  submittedSequence: ScalarNumber.int().optional(),
  answeredInTurn: AgentJournalAnsweredTurnSchema.optional(),
  recovered: z.literal(true).optional(),
  handoverRecorded: z.literal(true).optional(),
  handedOverAt: ScalarOptionalNumber,
  rejection: AgentSessionFailureFactSchema.optional(),
  queuedMessageId: ScalarOptionalNonemptyString,
  // The kind only; an object's other keys (a sender) are stripped, never published.
  source: z.object({ kind: ScalarString }).optional(),
  keptAsQueuedMessageId: ScalarOptionalNonemptyString,
  options: AgentSessionExecutionOptionsSchema.optional()
})

export function isAdmissibleAgentJournalSubmission(
  value: unknown
): value is AgentJournalSubmission {
  return AgentJournalSubmissionSchema.validate(value)
}

/** Compile-time proof that every submission this build writes is admissible. */
type Admits<T extends true> = T
export type CanonicalJournalSubmissionIsAdmissible = Admits<
  AgentJournalSubmission extends z.input<typeof AgentJournalSubmissionSchema> ? true : false
>
