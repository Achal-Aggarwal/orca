import {
  RpcBoolean,
  RpcOptionalString,
  RpcString,
  RpcPositiveInteger,
  RpcOptionalPositiveInteger
} from './rpc-value-schemas'
import { z } from 'zod'
import { RepoSelector, SlugRepo } from './github-repo-target-params'
import { OptionalString, requiredString } from './rpc-param-primitives'

export const UpdatePrTitle = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  title: requiredString('Missing title'),
  prRepo: SlugRepo.nullable().optional()
})

export const UpdatePr = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  updates: z.object({
    title: OptionalString,
    body: RpcOptionalString
  }),
  prRepo: SlugRepo.nullable().optional()
})

export const MergePr = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  method: z.enum(['merge', 'squash', 'rebase']).optional(),
  prRepo: SlugRepo.nullable().optional()
})

export const SetPrAutoMerge = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  enabled: RpcBoolean,
  method: z.enum(['merge', 'squash', 'rebase']).optional(),
  prRepo: SlugRepo.nullable().optional()
})

export const UpdatePrState = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  prRepo: SlugRepo.nullable().optional(),
  updates: z.object({
    state: z.enum(['open', 'closed'])
  })
})

export const MarkPrReadyForReview = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  prRepo: SlugRepo.nullable().optional()
})

export const RequestPrReviewers = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  prRepo: SlugRepo.nullable().optional(),
  reviewers: z.array(RpcString).min(1)
})

export const RemovePrReviewers = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  prRepo: SlugRepo.nullable().optional(),
  reviewers: z.array(RpcString).min(1)
})

export const PRReviewComment = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  prRepo: SlugRepo.nullable().optional(),
  commitId: requiredString('Missing PR head SHA'),
  path: requiredString('File path required'),
  line: RpcPositiveInteger,
  startLine: RpcOptionalPositiveInteger,
  body: requiredString('Comment body required')
})

export const PRReviewCommentReply = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  commentId: RpcPositiveInteger,
  body: requiredString('Comment body required'),
  threadId: OptionalString,
  path: OptionalString,
  line: RpcOptionalPositiveInteger,
  prRepo: SlugRepo.nullable().optional()
})
