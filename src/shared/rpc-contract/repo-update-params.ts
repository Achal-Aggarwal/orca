import { RpcNumber, RpcOptionalUnknown, RpcString, RpcUnknown } from './rpc-value-schemas'
import { z } from 'zod'
import { normalizeRepoSourceControlAiOverrides } from '../source-control-ai'
import { normalizeRepoBadgeColor } from '../repo-badge-color'
import { sanitizeRepoIcon } from '../repo-icon'
import { normalizeGhAccountBinding } from '../github/account-binding'
import { normalizeJiraProjectReference } from '../jira/jira-project-reference'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../worktree/visibility-sources'
import { OptionalFiniteNumber, OptionalString } from './rpc-param-primitives'

export const RepoSourceControlAiOverrides = RpcOptionalUnknown.transform((value) =>
  value === undefined
    ? undefined
    : value === null
      ? null
      : normalizeRepoSourceControlAiOverrides(value)
)

export const RepoBadgeColor = RpcOptionalUnknown.transform((value) =>
  value === undefined ? undefined : (normalizeRepoBadgeColor(value) ?? undefined)
)

export const RepoUpstream = z
  .object({
    owner: RpcString.min(1),
    repo: RpcString.min(1)
  })
  .nullable()
  .optional()

// Infer the return type: an explicit ZodObject annotation erases named update fields into an open record.
export function createRepoUpdateSchema<T extends Readonly<Record<string, z.ZodType>>>(
  selectorFields: T
) {
  return z.object({
    ...selectorFields,
    updates: z.object({
      displayName: OptionalString,
      badgeColor: RepoBadgeColor,
      repoIcon: RpcUnknown.transform((value) => sanitizeRepoIcon(value)).optional(),
      upstream: RepoUpstream,
      hookSettings: RpcOptionalUnknown,
      worktreeBaseRef: OptionalString,
      worktreeBasePath: OptionalString,
      kind: z.enum(['git', 'folder']).optional(),
      symlinkPaths: z.array(RpcString).optional(),
      issueSourcePreference: z.enum(['auto', 'upstream', 'origin']).optional(),
      defaultJiraProject: RpcOptionalUnknown.transform(normalizeJiraProjectReference),
      ghAccount: RpcOptionalUnknown.transform((value) => {
        if (value === undefined) {
          return undefined
        }
        if (value === null) {
          return null
        }
        // Why: malformed bindings must omit the key (IPC deletes); never clear via undefined.
        return normalizeGhAccountBinding(value) ?? undefined
      }),
      forkSyncMode: z.enum(['ask', 'safe-auto', 'off']).optional(),
      externalWorktreeVisibility: z.enum(['hide', 'show']).nullable().optional(),
      externalWorktreeVisibilityPromptDismissedAt: RpcNumber.finite().optional(),
      externalWorktreeInboxBaselinePaths: z.array(RpcString).optional(),
      importedExternalWorktreePaths: z.array(RpcString).optional(),
      agentWorktreeVisibility: z.enum(['hide', 'show']).nullable().optional(),
      customWorktreeVisibilitySources: RpcUnknown.transform((value) =>
        normalizeCustomWorktreeVisibilitySources(value)
      ).optional(),
      worktreeVisibilitySourcePreferences: RpcUnknown.transform((value) =>
        normalizeWorktreeVisibilitySourcePreferences(value)
      ).optional(),
      externalWorktreeDiscoverySuppressedAt: RpcNumber.finite().nullable().optional(),
      projectGroupId: OptionalString.nullable().optional(),
      projectGroupOrder: OptionalFiniteNumber,
      sourceControlAi: RepoSourceControlAiOverrides
    })
  })
}
