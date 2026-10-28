import {
  ScalarNonemptyString,
  ScalarNullableString,
  ScalarOptionalBoolean,
  ScalarOptionalFiniteNumber,
  ScalarOptionalNonemptyString,
  ScalarOptionalNullableString,
  ScalarOptionalString,
  ScalarOptionalUnknown,
  ScalarString
} from '../../../shared/scalar-value-schemas'
import { z } from 'zod'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { TaskSourceContextSchema } from '../../../shared/task-source-context-schema'
import { WorkspaceLinkedItemSchema } from '../../../shared/workspace-linked-item-schema'
import { WorkspaceAttachmentsSchema } from '../../../shared/workspace-attachment-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import { DiffCommentSchema } from '../../../shared/diff-comment-schema'
import { normalizeExecutionHostId } from '../../../shared/execution-host'

export const ProjectGroupCreateArgs = z.object({
  name: ScalarNonemptyString,
  parentPath: ScalarOptionalNullableString,
  connectionId: ScalarOptionalNullableString,
  parentGroupId: ScalarOptionalNullableString,
  createdFrom: z.enum(['manual', 'folder-scan', 'migration']).optional()
})

export const ProjectGroupUpdateArgs = z.object({
  groupId: ScalarNonemptyString,
  updates: z.object({
    name: ScalarOptionalString,
    isCollapsed: ScalarOptionalBoolean,
    tabOrder: ScalarOptionalFiniteNumber,
    color: ScalarOptionalNullableString
  })
})

export const ProjectGroupSelectorArgs = z.object({
  groupId: ScalarNonemptyString
})

export const ProjectHostSetupExistingFolderIpcArgs = z.object({
  projectId: ScalarNonemptyString,
  projectProviderIdentity: z
    .object({
      provider: z.literal('github'),
      owner: ScalarNonemptyString,
      repo: ScalarNonemptyString,
      host: ScalarOptionalNonemptyString
    })
    .optional(),
  hostId: ScalarNonemptyString,
  path: ScalarNonemptyString,
  kind: z.enum(['git', 'folder']).optional(),
  displayName: ScalarOptionalNonemptyString,
  setupMethod: z.enum(['imported-existing-folder', 'cloned']).optional()
})

const LocalWindowsRuntimePreferenceIpcArgs = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit-global') }),
  z.object({ kind: z.literal('windows-host') }),
  z.object({ kind: z.literal('wsl'), distro: ScalarNonemptyString })
])

export const ProjectUpdateIpcArgs = z.object({
  projectId: ScalarNonemptyString,
  updates: z.object({
    localWindowsRuntimePreference: LocalWindowsRuntimePreferenceIpcArgs.optional()
  })
})

const IpcExecutionHostId = ScalarNonemptyString.transform((value, ctx) => {
  const hostId = normalizeExecutionHostId(value)
  if (!hostId) {
    ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
    return z.NEVER
  }
  return hostId
})

// Omitted host retains legacy behavior: move the first matching project ID.
export const ProjectGroupMoveProjectArgs = z.object({
  projectId: ScalarNonemptyString,
  groupId: ScalarNullableString,
  order: ScalarOptionalFiniteNumber,
  hostId: IpcExecutionHostId.optional()
})

export const ProjectHostSetupCreateIpcArgs = z.object({
  projectId: ScalarNonemptyString,
  hostId: IpcExecutionHostId,
  setupId: ScalarOptionalNonemptyString,
  path: ScalarOptionalString,
  kind: z.enum(['git', 'folder']).optional(),
  displayName: ScalarOptionalNonemptyString,
  worktreeBasePath: ScalarOptionalString,
  gitUsername: ScalarOptionalString,
  setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
  setupMethod: z.enum(['imported-existing-folder', 'cloned', 'provisioned']).optional()
})

export const ProjectHostSetupUpdateIpcArgs = z.object({
  setupId: ScalarNonemptyString,
  hostId: IpcExecutionHostId.optional(),
  updates: z.object({
    displayName: ScalarOptionalString,
    path: ScalarOptionalString,
    worktreeBasePath: ScalarOptionalString,
    setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
    setupMethod: z
      .enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned'])
      .optional(),
    gitUsername: ScalarOptionalString,
    kind: z.enum(['git', 'folder']).optional()
  })
})

export const ProjectHostSetupDeleteIpcArgs = z.object({
  setupId: ScalarNonemptyString,
  hostId: IpcExecutionHostId.optional()
})

const FolderWorkspaceLinkedTaskArgs = WorkspaceLinkedItemSchema.nullable()

function assertFolderWorkspaceLinkedSourceContextMatch(
  value: {
    linkedTask?: z.infer<typeof FolderWorkspaceLinkedTaskArgs>
    linkedTaskSourceContext?: z.infer<typeof TaskSourceContextSchema> | null
  },
  ctx: z.RefinementCtx
): void {
  if (
    value.linkedTask &&
    value.linkedTaskSourceContext &&
    !isWorkspaceLinkedItemSourceContextMatch(value.linkedTask, value.linkedTaskSourceContext)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Linked task and source context identities must match'
    })
  }
}

export const FolderWorkspaceCreateArgs = z
  .object({
    projectGroupId: ScalarNonemptyString,
    name: ScalarOptionalString,
    folderPath: ScalarOptionalNullableString,
    connectionId: ScalarOptionalNullableString,
    linkedTask: FolderWorkspaceLinkedTaskArgs.optional(),
    linkedItems: WorkspaceAttachmentsSchema.optional(),

    linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
    createdWithAgent: ScalarString.refine(isTuiAgent).optional(),
    pendingFirstAgentMessageRename: ScalarOptionalBoolean
  })
  .superRefine(assertFolderWorkspaceLinkedSourceContextMatch)

export const FolderWorkspaceUpdateArgs = z.object({
  folderWorkspaceId: ScalarNonemptyString,
  updates: z
    .object({
      name: ScalarOptionalString,
      folderPath: ScalarOptionalString,
      linkedTask: FolderWorkspaceLinkedTaskArgs.optional(),
      linkedItems: WorkspaceAttachmentsSchema.optional(),
      linkedItemsBase: WorkspaceAttachmentsSchema.optional(),
      linkedItemsSelectionChanged: ScalarOptionalBoolean,
      linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
      comment: ScalarOptionalString,
      isArchived: ScalarOptionalBoolean,
      isUnread: ScalarOptionalBoolean,
      isPinned: ScalarOptionalBoolean,
      sortOrder: ScalarOptionalFiniteNumber,
      manualOrder: ScalarOptionalFiniteNumber,
      workspaceStatus: ScalarOptionalString,
      createdWithAgent: ScalarString.refine(isTuiAgent).optional(),
      pendingFirstAgentMessageRename: ScalarOptionalBoolean,
      firstAgentMessageRenameError: ScalarOptionalNullableString,
      lastActivityAt: ScalarOptionalFiniteNumber,
      diffComments: z.array(DiffCommentSchema).optional()
    })
    .superRefine(assertFolderWorkspaceLinkedSourceContextMatch)
})

export const FolderWorkspaceSelectorArgs = z.object({
  folderWorkspaceId: ScalarNonemptyString
})

export const FolderWorkspacePathStatusArgs = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('folder-workspace'),
    folderWorkspaceId: ScalarNonemptyString
  }),
  z.object({
    scope: z.literal('project-group'),
    projectGroupId: ScalarNonemptyString
  }),
  z.object({
    scope: z.literal('path'),
    path: ScalarNonemptyString,
    connectionId: ScalarNonemptyString.nullable().optional()
  })
])

export const ProjectGroupScanNestedArgs = z.object({
  path: ScalarNonemptyString,
  connectionId: ScalarOptionalNonemptyString,
  scanId: ScalarOptionalNonemptyString,
  options: ScalarOptionalUnknown
})

export const ProjectGroupCancelNestedScanArgs = z.object({
  scanId: ScalarNonemptyString
})

export const ProjectGroupImportNestedArgs = z.discriminatedUnion('mode', [
  z.object({
    parentPath: ScalarNonemptyString,
    groupName: ScalarOptionalString.default(''),
    projectPaths: z.array(ScalarString),
    connectionId: ScalarOptionalNonemptyString,
    scanId: ScalarOptionalNonemptyString,
    mode: z.literal('group')
  }),
  z.object({
    parentPath: ScalarNonemptyString,
    groupName: ScalarOptionalString.default(''),
    projectPaths: z.array(ScalarString),
    connectionId: ScalarOptionalNonemptyString,
    scanId: ScalarOptionalNonemptyString,
    mode: z.literal('separate')
  })
])

export function parseProjectGroupIpcArgs<T>(
  schema: z.ZodType<T>,
  value: unknown,
  errorCode: string
): T {
  const result = schema.safeParse(value)
  if (result.success) {
    return result.data
  }
  throw new Error(errorCode)
}
