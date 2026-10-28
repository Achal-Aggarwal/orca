import { RpcNullableString, RpcNumber, RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import { SlugRepo } from './github-repo-target-params'
import { OptionalString, requiredString } from './rpc-param-primitives'
import { IssueUpdate } from './github-issue-update-params'

export const SlugAssignableUsers = SlugRepo.extend({
  seedLogins: z.array(RpcString).optional()
})

export const ProjectOwnerType = z.enum(['organization', 'user'])

export const ProjectViewTable = z.object({
  owner: requiredString('Missing owner'),
  // Preserve Enterprise host through Zod parsing so gh requests target the correct host.
  host: OptionalString,
  ownerType: ProjectOwnerType,
  projectNumber: RpcNumber.int().positive(),
  viewId: OptionalString,
  viewNumber: RpcNumber.int().positive().optional(),
  viewName: OptionalString,
  queryOverride: OptionalString
})

export const ProjectWorkItemDetailsBySlug = SlugRepo.extend({
  number: RpcNumber.int().positive(),
  type: z.enum(['issue', 'pr'])
})

export const ProjectRef = z.object({
  input: requiredString('Missing project reference'),
  host: OptionalString
})

export const ProjectViews = z.object({
  owner: requiredString('Missing owner'),
  host: OptionalString,
  ownerType: ProjectOwnerType,
  projectNumber: RpcNumber.int().positive()
})

export const ProjectItemField = z.object({
  projectId: requiredString('Missing project ID'),
  host: OptionalString,
  itemId: requiredString('Missing item ID'),
  fieldId: requiredString('Missing field ID'),
  value: z.any()
})

export const ClearProjectItemField = z.object({
  projectId: requiredString('Missing project ID'),
  host: OptionalString,
  itemId: requiredString('Missing item ID'),
  fieldId: requiredString('Missing field ID')
})

export const SlugIssueUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  host: OptionalString,
  number: RpcNumber.int().positive(),
  updates: IssueUpdate
})

export const SlugPullRequestUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  host: OptionalString,
  number: RpcNumber.int().positive(),
  updates: z.object({
    state: z.enum(['open', 'closed']).optional(),
    title: OptionalString,
    body: OptionalString
  })
})

export const SlugIssueTypeUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  host: OptionalString,
  number: RpcNumber.int().positive(),
  issueTypeId: RpcNullableString
})

export const SlugIssueComment = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  host: OptionalString,
  number: RpcNumber.int().positive(),
  body: requiredString('Comment body required')
})

export const SlugIssueCommentEdit = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  host: OptionalString,
  commentId: RpcNumber.int().positive(),
  body: requiredString('Comment body required')
})

export const SlugIssueCommentDelete = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  host: OptionalString,
  commentId: RpcNumber.int().positive()
})

export const GithubProjectListAccessibleParams = z.object({ host: OptionalString })
