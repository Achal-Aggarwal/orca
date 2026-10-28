import { ScalarNull, ScalarString } from '../../../shared/scalar-value-schemas'
import { z } from 'zod'
import type { AcpDialect } from './acp-dialect'

const response = z.union([
  z.object({
    error: ScalarNull.optional(),
    result: z.object({
      taskId: ScalarString,
      outcome: z.enum(['killed', 'already_exited', 'not_found'])
    })
  }),
  z.object({ result: ScalarNull, error: ScalarString })
])

export const grokBackgroundTaskStop: NonNullable<AcpDialect['backgroundTaskStop']> = {
  probe: { method: '_x.ai/task/kill', params: {} },
  lacksRoute: (error) => error.code === -32601,
  // Omit source to use Grok's per-task UI kill behavior.
  request: (sessionId, taskId) => ({ method: '_x.ai/task/kill', params: { sessionId, taskId } }),
  response: (value, taskId) => {
    const parsed = response.safeParse(value)
    if (!parsed.success || (parsed.data.result && parsed.data.result.taskId !== taskId)) {
      throw new Error('Grok returned an invalid background task kill response')
    }
    const { result } = parsed.data
    return !result ? 'refused' : result.outcome === 'killed' ? 'killed' : 'gone'
  }
}
