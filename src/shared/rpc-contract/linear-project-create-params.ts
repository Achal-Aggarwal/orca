import { RpcNull, RpcNumber, RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import { OptionalString, requiredString } from './rpc-param-primitives'

export const LinearPriority = RpcNumber.int().min(0).max(4).optional()

export const LinearLabelIds = z.array(requiredString('Invalid label ID')).optional()

export const CreateProject = z.object({
  name: requiredString('Project name is required'),
  description: OptionalString,
  content: OptionalString,
  workspaceId: OptionalString,
  teamIds: z.array(requiredString('Invalid team ID')).min(1, 'At least one team is required'),
  leadId: z.union([RpcString, RpcNull]).optional(),
  memberIds: z.array(requiredString('Invalid member ID')).optional(),
  labelIds: LinearLabelIds,
  priority: LinearPriority,
  startDate: OptionalString,
  targetDate: OptionalString
})
