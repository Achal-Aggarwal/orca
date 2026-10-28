import { RpcNumber, RpcOptionalBoolean } from './rpc-value-schemas'
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
    limit: RpcNumber.int().positive().optional()
  })
  .refine((params) => !(params.worktree && params.repo), {
    message: '--repo and --worktree cannot be combined'
  })
