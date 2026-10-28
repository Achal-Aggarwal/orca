import { RpcOptionalBoolean, RpcOptionalPositiveInteger } from './rpc-value-schemas'
import { z } from 'zod'
import { requiredString, OptionalString } from './rpc-param-primitives'

export const ReferenceList = z.object({
  worktree: requiredString('Missing worktree selector'),
  cwd: OptionalString
})

export const ReferenceFind = z
  .object({
    query: requiredString('Missing reference URL or issue key'),
    worktree: OptionalString,
    cwd: OptionalString,
    repo: OptionalString,
    includeArchived: RpcOptionalBoolean,
    limit: RpcOptionalPositiveInteger
  })
  .refine((params) => !(params.worktree && params.repo), {
    message: '--repo and --worktree cannot be combined'
  })
