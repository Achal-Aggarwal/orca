import { ScalarUnknown } from './scalar-value-schemas'
import { z } from 'zod'
import { normalizeStoredTaskSourceContext, type TaskSourceContext } from './task-source-context'

export const TaskSourceContextSchema = ScalarUnknown.transform((value, ctx): TaskSourceContext => {
  const normalized = normalizeStoredTaskSourceContext(value)
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: 'Invalid task source context' })
    return z.NEVER
  }
  return normalized
})
