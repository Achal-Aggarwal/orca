import { RpcNumber, RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import { RepoSelector, SlugRepo } from './github-repo-target-params'
import { requiredString } from './rpc-param-primitives'
import { IssueUpdate } from './github-issue-update-params'

export const Issue = RepoSelector.extend({
  number: RpcNumber.int().positive()
})

export const CreateIssue = RepoSelector.extend({
  title: requiredString('Missing title'),
  body: RpcString,
  labels: z.array(RpcString).optional(),
  assignees: z.array(RpcString).optional()
})

export const UpdateIssue = RepoSelector.extend({
  number: RpcNumber.int().positive(),
  updates: IssueUpdate
})

export const IssueComment = RepoSelector.extend({
  number: RpcNumber.int().positive(),
  body: requiredString('Comment body required'),
  type: z.enum(['issue', 'pr']).optional(),
  prRepo: SlugRepo.nullable().optional()
})
