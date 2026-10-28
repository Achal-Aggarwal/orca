import { RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import { OptionalString } from './rpc-param-primitives'

// Why: repo-selector and slug-addressed issue updates must accept the identical field set.
export const IssueUpdate = z.object({
  state: z.enum(['open', 'closed']).optional(),
  title: OptionalString,
  body: OptionalString,
  addLabels: z.array(RpcString).optional(),
  removeLabels: z.array(RpcString).optional(),
  addAssignees: z.array(RpcString).optional(),
  removeAssignees: z.array(RpcString).optional()
})
