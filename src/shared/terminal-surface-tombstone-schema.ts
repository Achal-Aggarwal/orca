import { ScalarFiniteNumber, ScalarNonemptyString, ScalarString } from './scalar-value-schemas'
import { z } from 'zod'

import { terminalTabIdSchema } from './terminal-tab-id-schema'

export const terminalSurfaceTombstoneSchema = z.object({
  worktreeId: ScalarString,
  parentTabId: terminalTabIdSchema,
  leafId: ScalarString,
  ptyId: ScalarString,
  incarnationId: ScalarNonemptyString.max(128),
  retiredAt: ScalarFiniteNumber.nonnegative()
})
