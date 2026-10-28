import {
  RpcNumber,
  RpcOptionalBoolean,
  RpcOptionalNullableString,
  RpcOptionalString,
  RpcString
} from './rpc-value-schemas'
import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'
import { OptionalGitAdmissionTier } from './git-admission-tier-params'

export const HostedReviewForBranch = z.object({
  repo: requiredString('Missing repo selector'),
  branch: requiredString('Missing branch'),
  force: RpcOptionalBoolean,
  admissionTier: OptionalGitAdmissionTier,
  currentHeadOid: RpcOptionalNullableString,
  // Only the caller's selected worktree; the host caps how many earn the fast tier.
  active: RpcOptionalBoolean,
  linkedGitHubPR: RpcNumber.int().positive().nullable().optional(),
  fallbackGitHubPR: RpcNumber.int().positive().nullable().optional(),
  linkedGitLabMR: RpcNumber.int().positive().nullable().optional(),
  linkedBitbucketPR: RpcNumber.int().positive().nullable().optional(),
  linkedAzureDevOpsPR: RpcNumber.int().positive().nullable().optional(),
  linkedGiteaPR: RpcNumber.int().positive().nullable().optional()
})

export const HostedReviewCreationEligibility = z.object({
  repo: requiredString('Missing repo selector'),
  worktree: RpcString.min(1, 'Missing worktree selector').optional(),
  branch: requiredString('Missing branch'),
  base: RpcOptionalNullableString,
  hasUncommittedChanges: RpcOptionalBoolean,
  hasUpstream: RpcOptionalBoolean,
  ahead: RpcNumber.int().nonnegative().optional(),
  behind: RpcNumber.int().nonnegative().optional(),
  linkedGitHubPR: RpcNumber.int().positive().nullable().optional(),
  fallbackGitHubPR: RpcNumber.int().positive().nullable().optional(),
  linkedGitLabMR: RpcNumber.int().positive().nullable().optional(),
  linkedBitbucketPR: RpcNumber.int().positive().nullable().optional(),
  linkedAzureDevOpsPR: RpcNumber.int().positive().nullable().optional(),
  linkedGiteaPR: RpcNumber.int().positive().nullable().optional()
})

export const HostedReviewCreate = z.object({
  repo: requiredString('Missing repo selector'),
  worktree: RpcString.min(1, 'Missing worktree selector').optional(),
  // Keep provider open: clients echo a newer host’s eligibility token; the handler refuses unsupported providers.
  provider: RpcString,
  base: requiredString('Missing base branch'),
  head: RpcOptionalString,
  title: requiredString('Missing title'),
  body: RpcOptionalString,
  draft: RpcOptionalBoolean,
  useTemplate: RpcOptionalBoolean
})
