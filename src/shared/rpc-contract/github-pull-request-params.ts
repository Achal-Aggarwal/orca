import {
  RpcBoolean,
  RpcOptionalBoolean,
  RpcOptionalNullableString,
  RpcOptionalUnknown,
  RpcPositiveInteger,
  RpcOptionalNullablePositiveInteger,
  RpcOptionalPositiveInteger
} from './rpc-value-schemas'
import { z } from 'zod'
import type { GitHubPRRefreshReason } from '../github/pull-request-refresh-types'
import { RepoSelector, SlugRepo } from './github-repo-target-params'
import { OptionalString, requiredString } from './rpc-param-primitives'

export const OptionalPRRefreshReason = RpcOptionalUnknown.transform(
  (value): GitHubPRRefreshReason | undefined => {
    return value === 'visible' ||
      value === 'active' ||
      value === 'post-push' ||
      value === 'manual' ||
      value === 'swr'
      ? value
      : undefined
  }
)

export const PrForBranch = RepoSelector.extend({
  branch: requiredString('Missing branch'),
  reason: OptionalPRRefreshReason,
  linkedPRNumber: RpcOptionalNullablePositiveInteger,
  fallbackPRNumber: RpcOptionalNullablePositiveInteger,
  acceptMergedFallbackPR: RpcOptionalBoolean,
  currentHeadOid: RpcOptionalNullableString
})

export const PullRequest = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  noCache: RpcOptionalBoolean,
  prRepo: SlugRepo.nullable().optional()
})

export const PRCommentReaction = RepoSelector.extend({
  reactionSubjectId: requiredString('Missing reaction subject ID'),
  content: z.enum(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes']),
  reacted: RpcBoolean,
  prRepo: SlugRepo.nullable().optional()
})

export const PullRequestChecks = PullRequest.extend({
  headSha: OptionalString
})

export const PullRequestCheckDetails = RepoSelector.extend({
  checkRunId: RpcOptionalPositiveInteger,
  workflowRunId: RpcOptionalPositiveInteger,
  checkName: OptionalString,
  url: OptionalString.nullable().optional(),
  prRepo: SlugRepo.nullable().optional()
})

export const RerunPullRequestChecks = PullRequest.extend({
  headSha: OptionalString,
  failedOnly: RpcOptionalBoolean
})

export const PullRequestFileContents = RepoSelector.extend({
  prNumber: RpcPositiveInteger,
  prRepo: SlugRepo.nullable().optional(),
  path: requiredString('Missing file path'),
  oldPath: OptionalString,
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  headSha: requiredString('Missing head SHA'),
  baseSha: requiredString('Missing base SHA')
})

export const PullRequestFileViewed = RepoSelector.extend({
  prRepo: SlugRepo.nullable().optional(),
  pullRequestId: requiredString('Missing pull request ID'),
  path: requiredString('Missing file path'),
  viewed: RpcBoolean
})

export const ReviewThread = RepoSelector.extend({
  prRepo: SlugRepo.nullable().optional(),
  threadId: requiredString('Missing thread ID'),
  resolve: RpcBoolean
})
