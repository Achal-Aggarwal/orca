import { ScalarNonemptyString, ScalarString } from './scalar-value-schemas'
import { z } from 'zod'

/** Keep newer kinds/audiences/refusal details readable like row state; the fact reader drops anything it cannot place. */
export const AgentSessionFailureFactSchema = z.object({
  kind: ScalarNonemptyString,
  detail: z.object({ text: ScalarString, audience: ScalarNonemptyString }).optional(),
  refusal: z
    .object({ code: ScalarNonemptyString, details: z.looseObject({}).optional() })
    .optional(),
  argumentProblem: z
    .object({ agent: ScalarString, option: ScalarString, problem: ScalarString })
    .optional(),
  requestTimeout: z.looseObject({}).optional()
})
