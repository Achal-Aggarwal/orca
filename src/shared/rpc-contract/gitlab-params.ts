import {
  RpcBoolean,
  RpcNumber,
  RpcOptionalBoolean,
  RpcOptionalString,
  RpcOptionalUnknown,
  RpcString
} from './rpc-value-schemas'
import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

export const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

export const EmptyParams = z.object({}).optional().default({})

export const GitLabRateLimit = z
  .object({
    force: RpcOptionalBoolean,
    host: OptionalString
  })
  .optional()
  .default({})

// Callers normalize absent refs to null; optional alone would reject those payloads.
export const GitLabProjectRef = z
  .object({
    host: requiredString('Missing GitLab host'),
    path: requiredString('Missing GitLab project path')
  })
  .nullish()

export const WorkItemsList = RepoSelector.extend({
  state: z.enum(['opened', 'merged', 'closed', 'all']).optional(),
  page: OptionalFiniteNumber,
  perPage: OptionalFiniteNumber,
  query: OptionalString
})

export const IssuesList = RepoSelector.extend({
  state: RpcOptionalUnknown,
  assignee: OptionalString,
  limit: OptionalFiniteNumber,
  page: OptionalFiniteNumber
})

export const CreateIssue = RepoSelector.extend({
  title: requiredString('Missing title'),
  body: RpcString
})

export const IssueUpdate = z.object({
  state: z.enum(['opened', 'closed']).optional(),
  title: RpcOptionalString,
  body: RpcOptionalString,
  addLabels: z.array(RpcString).optional(),
  removeLabels: z.array(RpcString).optional(),
  addAssignees: z.array(RpcString).optional(),
  removeAssignees: z.array(RpcString).optional()
})

export const UpdateIssue = RepoSelector.extend({
  number: RpcNumber.int().positive(),
  updates: IssueUpdate,
  projectRef: GitLabProjectRef
})

export const UpdateMrState = RepoSelector.extend({
  iid: RpcNumber.int().positive(),
  state: z.enum(['opened', 'closed']),
  projectRef: GitLabProjectRef
})

export const UpdateMr = RepoSelector.extend({
  iid: RpcNumber.int().positive(),
  updates: z.object({
    title: RpcOptionalString,
    body: RpcOptionalString,
    addLabels: z.array(RpcString).optional(),
    removeLabels: z.array(RpcString).optional(),
    readyForReview: z.literal(true).optional()
  }),
  projectRef: GitLabProjectRef
})

export const UpdateMrReviewers = RepoSelector.extend({
  iid: RpcNumber.int().positive(),
  reviewerIds: z.array(RpcNumber.int().nonnegative()),
  projectRef: GitLabProjectRef
})

export const MergeMr = RepoSelector.extend({
  iid: RpcNumber.int().positive(),
  method: z.enum(['merge', 'squash', 'rebase']).optional(),
  projectRef: GitLabProjectRef
})

export const AddIssueComment = RepoSelector.extend({
  number: RpcNumber.int().positive(),
  body: requiredString('Comment body is required'),
  projectRef: GitLabProjectRef
})

export const AddMRComment = RepoSelector.extend({
  iid: RpcNumber.int().positive(),
  body: requiredString('Comment body is required'),
  projectRef: GitLabProjectRef
})

export const AddMRInlineComment = RepoSelector.extend({
  iid: RpcNumber.int().positive(),
  input: z.object({
    body: requiredString('Comment body is required'),
    path: requiredString('File path is required'),
    oldPath: RpcOptionalString,
    line: RpcNumber.int().positive(),
    baseSha: requiredString('Base SHA is required'),
    startSha: requiredString('Start SHA is required'),
    headSha: requiredString('Head SHA is required')
  }),
  projectRef: GitLabProjectRef
})

export const ResolveMRDiscussion = RepoSelector.extend({
  iid: RpcNumber.int().positive(),
  discussionId: requiredString('Discussion id is required'),
  resolved: RpcBoolean,
  projectRef: GitLabProjectRef
})

export const JobTrace = RepoSelector.extend({
  jobId: RpcNumber.int().positive(),
  projectRef: GitLabProjectRef,
  // CI traces exceed the 1 MB frame cap; excerpt callers need the host to bound them before transport.
  logExcerpt: RpcOptionalBoolean
})

export const RetryJob = RepoSelector.extend({
  jobId: RpcNumber.int().positive(),
  projectRef: GitLabProjectRef
})

export const WorkItemDetails = RepoSelector.extend({
  iid: RpcNumber.int().positive(),
  type: z.enum(['issue', 'mr']),
  projectRef: GitLabProjectRef,
  includeReviewDetails: RpcOptionalBoolean
})

export const WorkItemByPath = RepoSelector.extend({
  host: requiredString('Missing GitLab host'),
  path: requiredString('Missing GitLab project path'),
  iid: RpcNumber.int().positive(),
  type: z.enum(['issue', 'mr'])
})
