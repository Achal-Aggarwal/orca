import { RpcOptionalNullableString, RpcOptionalString, RpcString } from './rpc-value-schemas'
import { z } from 'zod'

/** Strict state behind ui.set’s field catch: a future key drops the whole state while reporting success.
 * Only add cross-version state here; per-device view preferences belong in local storage. */
export const TaskResumeState = z
  .object({
    githubMode: z.enum(['items', 'project']).optional(),
    githubItemsPreset: RpcOptionalNullableString,
    githubItemsQuery: RpcOptionalString,
    githubProjectHiddenFieldIdsByView: z.record(RpcString, z.array(RpcString)).optional(),
    linearMode: z.enum(['issues', 'projects', 'views', 'in-orca']).optional(),
    linearPreset: z.enum(['assigned', 'created', 'all', 'completed']).optional(),
    linearQuery: RpcOptionalString,
    linearContext: z
      .object({
        kind: z.enum(['project', 'view']),
        id: RpcString,
        workspaceId: RpcString,
        model: z.enum(['issue', 'project']).optional()
      })
      .strict()
      .optional(),
    jiraPreset: z.enum(['assigned', 'reported', 'all', 'done']).optional(),
    jiraQuery: RpcOptionalString
  })
  .strict()
