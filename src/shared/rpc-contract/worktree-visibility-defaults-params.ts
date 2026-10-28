import { RpcUnknown } from './rpc-value-schemas'
import { z } from 'zod'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../worktree/visibility-sources'

export const WorktreeVisibilityDefaultsUpdate = z
  .object({
    external: z.enum(['hide', 'show']).optional(),
    customSources: RpcUnknown.transform((value) =>
      normalizeCustomWorktreeVisibilitySources(value)
    ).optional(),
    sourcePreferences: RpcUnknown.transform((value) =>
      normalizeWorktreeVisibilitySourcePreferences(value)
    ).optional()
  })
  .strict()
