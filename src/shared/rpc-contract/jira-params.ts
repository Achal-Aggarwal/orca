import {
  RpcNull,
  RpcOptionalBoolean,
  RpcOptionalString,
  RpcString,
  RpcUnknown
} from './rpc-value-schemas'
import { JiraIssueListFiltersParam } from './jira-quick-filter-params'
import { z } from 'zod'
import {
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString
} from './rpc-param-primitives'

export const VALID_FILTERS = ['assigned', 'reported', 'all', 'done'] as const

export const SiteSelection = z
  .object({
    siteId: OptionalString,
    strict: RpcOptionalBoolean
  })
  .optional()

export const Connect = z.object({
  siteUrl: requiredString('Site URL is required'),
  // Self-hosted PAT auth needs no email; connect() enforces it for Cloud.
  email: OptionalPlainString,
  apiToken: requiredString('API token is required'),
  authType: z.enum(['cloud', 'server']).optional()
})

export const SelectSite = z.object({
  siteId: requiredString('Site ID is required')
})

export const SearchIssues = z.object({
  jql: requiredString('Missing JQL'),
  limit: OptionalFiniteNumber,
  siteId: OptionalString,
  strict: RpcOptionalBoolean
})

export const ListIssues = z
  .object({
    filter: z.enum(VALID_FILTERS).optional(),
    limit: OptionalFiniteNumber,
    siteId: OptionalString,
    strict: RpcOptionalBoolean,
    filters: JiraIssueListFiltersParam.optional()
  })
  .optional()

export const IssueKey = z.object({
  key: requiredString('Issue key is required'),
  siteId: OptionalString,
  strict: RpcOptionalBoolean,
  mediaFormat: z.literal('reference').optional()
})

export const AttachmentImage = z.object({
  reference: RpcString.uuid(),
  transferId: RpcString.uuid()
})

export const CreateIssue = z.object({
  siteId: OptionalString,
  projectId: requiredString('Project is required'),
  issueTypeId: requiredString('Issue type is required'),
  title: requiredString('Title is required'),
  description: OptionalPlainString,
  customFields: z.record(RpcString, RpcUnknown).optional(),
  userFieldKeys: z.array(RpcString).optional()
})

export const IssueUpdate = z.object({
  key: requiredString('Issue key is required'),
  siteId: OptionalString,
  updates: z
    .object({
      title: OptionalString,
      labels: z.array(RpcString).optional(),
      labelOperations: z
        .object({
          add: z.array(requiredString('Label cannot be empty')).optional(),
          remove: z.array(requiredString('Label cannot be empty')).optional()
        })
        .strict()
        .optional(),
      assigneeAccountId: z.union([RpcString, RpcNull]).optional(),
      priorityId: z.union([RpcString, RpcNull]).optional(),
      transitionId: OptionalString,
      transitionFields: z.record(RpcString, RpcUnknown).optional(),
      transitionComment: RpcOptionalString
    })
    .refine((updates) => !(updates.labels && updates.labelOperations), {
      message: 'Pass labels or labelOperations, not both'
    })
})

export const IssueComment = z.object({
  key: requiredString('Issue key is required'),
  body: requiredString('Comment body is required'),
  siteId: OptionalString
})

export const ProjectIssueTypes = z.object({
  projectIdOrKey: requiredString('Project is required'),
  siteId: OptionalString,
  strict: RpcOptionalBoolean
})

export const ProjectIssueTypeFields = z.object({
  projectIdOrKey: requiredString('Project is required'),
  issueTypeId: requiredString('Issue type is required'),
  siteId: OptionalString,
  strict: RpcOptionalBoolean
})

export const AssignableUsers = z.object({
  key: requiredString('Issue key is required'),
  query: OptionalPlainString,
  siteId: OptionalString,
  strict: RpcOptionalBoolean
})

export const UserSearch = z.object({
  query: OptionalPlainString,
  siteId: OptionalString
})

export const ProjectStatusOrder = z.object({
  projectKey: requiredString('Project key is required'),
  siteId: OptionalString
})

export const CancelGenerateIssueSummary = z.object({
  siteId: requiredString('Site ID is required'),
  requestId: RpcString.trim().min(1).max(128),
  draftId: RpcString.trim().min(1).max(128)
})

export const GenerateIssueSummary = CancelGenerateIssueSummary.extend({
  description: RpcString.trim().min(1).max(32_000),
  projectName: RpcString.max(255).optional(),
  issueTypeName: RpcString.max(255).optional()
})
