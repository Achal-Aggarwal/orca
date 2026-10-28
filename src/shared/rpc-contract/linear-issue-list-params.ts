import { RpcNumber, RpcOptionalBoolean } from './rpc-value-schemas'
import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString } from './rpc-param-primitives'
import { LinearIssueAttributeFilterSchema } from './linear-issue-attribute-filter-params'

export const LegacyListIssues = z
  .object({
    filter: z.enum(['assigned', 'created', 'all', 'completed']).optional(),
    limit: OptionalFiniteNumber,
    workspaceId: OptionalString,
    attributeFilter: LinearIssueAttributeFilterSchema.optional()
  })
  .strict()
  .optional()

export const McpListIssues = z
  .object({
    team: OptionalString,
    cycle: OptionalString,
    label: OptionalString,
    limit: RpcNumber.int().min(1).max(250).optional(),
    query: OptionalString,
    state: OptionalString,
    cursor: OptionalString,
    orderBy: z.enum(['createdAt', 'updatedAt']).optional(),
    project: OptionalString,
    release: OptionalString,
    assignee: OptionalString,
    delegate: OptionalString,
    parentId: OptionalString,
    priority: RpcNumber.int().min(0).max(4).optional(),
    createdAt: OptionalString,
    updatedAt: OptionalString,
    includeArchived: RpcOptionalBoolean,
    workspaceId: OptionalString
  })
  .strict()

export const ListIssues = z.union([McpListIssues, LegacyListIssues])
