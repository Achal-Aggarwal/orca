import {
  RpcBoolean,
  RpcNull,
  RpcNumber,
  RpcOptionalBoolean,
  RpcOptionalNullableString,
  RpcOptionalString,
  RpcString
} from './rpc-value-schemas'
import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

export const LINEAR_DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const LinearDueDate = RpcString.refine((value) => LINEAR_DUE_DATE_PATTERN.test(value), {
  message: 'Linear due dates must use YYYY-MM-DD'
})

export const OptionalLinearDueDate = LinearDueDate.optional()

export const OptionalLinearDueDateOrClear = z.union([LinearDueDate, RpcNull]).optional()

export const AgentSearchIssues = z.object({
  query: requiredString('Missing query'),
  limit: OptionalFiniteNumber,
  workspaceId: z.union([RpcString, z.literal('all')]).optional()
})

export const LinearWorkspaceRead = z.object({
  workspaceId: z.union([RpcString, z.literal('all')]).optional()
})

export const LinearTeamLookup = z.object({
  teamInput: requiredString('Missing team'),
  workspaceId: OptionalString.refine((value) => value !== 'all', {
    message: '--workspace all is only valid for team list'
  })
})

export const LinearIssueList = z.object({
  filter: z.enum(['assigned', 'created', 'all', 'completed', 'open']).optional(),
  teamInput: OptionalString,
  limit: OptionalFiniteNumber,
  workspaceId: z.union([RpcString, z.literal('all')]).optional()
})

export const LinearProjectList = z.object({
  query: OptionalString,
  limit: OptionalFiniteNumber,
  workspaceId: z.union([RpcString, z.literal('all')]).optional()
})

export const LinearIncludeFlags = z.object({
  comments: RpcBoolean,
  children: RpcBoolean,
  attachments: RpcBoolean,
  relations: RpcBoolean,
  activity: RpcBoolean.default(false)
})

export const LinearCurrentContext = z
  .object({
    worktreeId: OptionalString,
    terminalHandle: OptionalString,
    cwd: OptionalString,
    remote: RpcOptionalBoolean
  })
  .optional()

export const LinearWriteTarget = z.object({
  input: OptionalString,
  current: RpcOptionalBoolean,
  workspaceId: OptionalString.refine((value) => value !== 'all', {
    message: '--workspace all is not valid for Linear writes'
  }),
  context: LinearCurrentContext
})

export const AgentIssueContext = z.object({
  input: OptionalString,
  current: RpcOptionalBoolean,
  workspaceId: OptionalString,
  include: LinearIncludeFlags,
  depth: RpcNumber.int().min(0).max(5),
  context: LinearCurrentContext
})

export const LinearIssueSetState = LinearWriteTarget.extend({
  to: requiredString('Missing target state')
})

export const LinearIssueUpdateTask = LinearWriteTarget.extend({
  operation: z.enum(['assignee', 'priority', 'estimate', 'dueDate', 'labels']),
  assigneeId: RpcOptionalNullableString,
  assigneeMe: RpcOptionalBoolean,
  priority: RpcNumber.int().min(0).max(4).optional(),
  estimate: RpcNumber.int().min(0).nullable().optional(),
  dueDate: OptionalLinearDueDateOrClear,
  labelMode: z.enum(['add', 'remove', 'set']).optional(),
  labels: z.array(RpcString).optional()
})

export const LinearIssueAddComment = LinearWriteTarget.extend({
  body: requiredString('Missing comment body'),
  replyTo: OptionalString,
  writeId: OptionalString
})

const LinearCommentWorkspace = OptionalString.refine((value) => value !== 'all', {
  message: '--workspace all is not valid for Linear writes'
})

export const LinearCommentEdit = z.object({
  commentId: requiredString('Missing comment id'),
  body: requiredString('Missing comment body'),
  workspaceId: LinearCommentWorkspace
})

export const LinearCommentDelete = z.object({
  commentId: requiredString('Missing comment id'),
  workspaceId: LinearCommentWorkspace
})

export const LinearIssueRelationWrite = LinearWriteTarget.extend({
  relatedInput: requiredString('Missing related issue'),
  relationship: z.enum(['blocks', 'blockedBy', 'relatedTo', 'duplicateOf']),
  operation: z.enum(['add', 'remove'])
})

export const LinearIssueAttachLink = LinearWriteTarget.extend({
  url: requiredString('Missing attachment URL'),
  title: OptionalString,
  writeId: OptionalString
})

export const LinearIssueCreate = z.object({
  title: requiredString('Missing issue title'),
  body: OptionalString,
  teamInput: OptionalString,
  teamKey: OptionalString,
  state: OptionalString,
  assignee: OptionalString,
  priority: RpcNumber.int().min(0).max(4).optional(),
  estimate: RpcNumber.int().min(0).optional(),
  dueDate: OptionalLinearDueDate,
  labels: z.array(RpcString).optional(),
  projectInput: OptionalString,
  parentInput: OptionalString,
  parentCurrent: RpcOptionalBoolean,
  workspaceId: OptionalString.refine((value) => value !== 'all', {
    message: '--workspace all is not valid for Linear writes'
  }),
  writeId: OptionalString,
  context: LinearCurrentContext
})

export const LinearSaveIssue = LinearWriteTarget.extend({
  team: OptionalString,
  title: OptionalString,
  description: RpcOptionalString,
  state: OptionalString,
  assignee: RpcOptionalNullableString,
  priority: RpcNumber.int().min(0).max(4).optional(),
  estimate: RpcNumber.min(0).nullable().optional(),
  dueDate: OptionalLinearDueDateOrClear,
  labels: z.array(RpcString).optional(),
  project: RpcOptionalNullableString,
  parentId: RpcOptionalNullableString,
  writeId: OptionalString
})
