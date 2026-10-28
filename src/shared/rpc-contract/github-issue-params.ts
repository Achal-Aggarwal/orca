import { RpcString, RpcPositiveInteger } from './rpc-value-schemas'
import { z } from 'zod'
import { RepoSelector, SlugRepo } from './github-repo-target-params'
import { requiredString } from './rpc-param-primitives'
import { IssueUpdate } from './github-issue-update-params'

export const Issue = RepoSelector.extend({
  number: RpcPositiveInteger
})

export const CreateIssue = RepoSelector.extend({
  title: requiredString('Missing title'),
  body: RpcString,
  labels: z.array(RpcString).optional(),
  assignees: z.array(RpcString).optional()
})

export const UpdateIssue = RepoSelector.extend({
  number: RpcPositiveInteger,
  updates: IssueUpdate
})

export const IssueComment = RepoSelector.extend({
  number: RpcPositiveInteger,
  body: requiredString('Comment body required'),
  type: z.enum(['issue', 'pr']).optional(),
  prRepo: SlugRepo.nullable().optional()
})
