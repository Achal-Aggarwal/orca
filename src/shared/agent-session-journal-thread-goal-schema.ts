import { ScalarFiniteNumber, ScalarNonemptyString, ScalarString } from './scalar-value-schemas'
// The journal's thread-goal transition, validated as deeply as the rest of the render model.

import { z } from 'zod'
import { openDiscriminatedUnion } from './agent-session-journal-open-union'

const ThreadGoal = z.object({
  objective: ScalarString,
  status: ScalarNonemptyString,
  tokenBudget: ScalarFiniteNumber.nullable(),
  tokensUsed: ScalarFiniteNumber,
  timeUsedSeconds: ScalarFiniteNumber,
  createdAt: ScalarFiniteNumber,
  updatedAt: ScalarFiniteNumber
})

/** Like blocks: an unknown `state` stays admissible, a known one with a broken payload does not. */
export const AgentJournalThreadGoalStateSchema = openDiscriminatedUnion(
  z.discriminatedUnion('state', [
    z.object({ state: z.literal('set'), goal: ThreadGoal }),
    z.object({ state: z.literal('cleared') })
  ])
)
