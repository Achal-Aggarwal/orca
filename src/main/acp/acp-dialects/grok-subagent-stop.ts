import {
  ScalarBoolean,
  ScalarNull,
  ScalarOptionalString,
  ScalarString
} from '../../../shared/scalar-value-schemas'
import { z } from 'zod'
import type { AcpDialect } from './acp-dialect'
import { grokSubagentNotification } from './grok-subagents'

const response = z.object({
  error: ScalarNull.optional(),
  result: z.object({
    subagentId: ScalarString,
    cancelled: ScalarBoolean,
    outcome: z.looseObject({ kind: ScalarString, status: ScalarOptionalString }).optional()
  })
})

export const grokSubagentStop: NonNullable<AcpDialect['subagentStop']> = {
  probe: { method: '_x.ai/subagent/cancel', params: {} },
  recognizesProbeError: (error) =>
    error.code === -32602 &&
    typeof error.data === 'string' &&
    error.data.includes('missing field `subagentId`'),
  request: (sessionId, id) => ({
    method: '_x.ai/subagent/cancel',
    params: { sessionId, subagentId: id }
  }),
  response: (value, id) => {
    const parsed = response.safeParse(value)
    if (!parsed.success || parsed.data.result.subagentId !== id) {
      throw new Error('Grok returned an invalid child cancellation response')
    }
    const { cancelled, outcome } = parsed.data.result
    if (outcome?.kind === 'not_found') {
      return { cancelled: false }
    }
    if (outcome?.kind === 'already_finished') {
      if (outcome.status === undefined) {
        throw new Error('Grok returned an invalid child cancellation response')
      }
      const update = grokSubagentNotification({
        sessionUpdate: 'subagent_finished',
        subagent_id: id,
        status: outcome.status
      })
      return { cancelled: false, state: update?.state }
    }
    return { cancelled: outcome?.kind === 'cancelled' || cancelled }
  }
}
