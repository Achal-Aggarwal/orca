import {
  RpcOptionalBoolean,
  RpcOptionalNullableString,
  RpcOptionalString,
  RpcString
} from './rpc-value-schemas'
import { z } from 'zod'
import { WorkspaceLinkedItemSchema } from '../workspace-linked-item-schema'
import { WorkspaceAttachmentsSchema } from '../workspace-attachment-schema'
import { TaskSourceContextSchema } from '../task-source-context-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../workspace-linked-item-source-context'
import { isTuiAgent } from '../tui-agent-config'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'
import { DiffCommentSchema } from '../diff-comment-schema'

export const FolderWorkspaceLinkedTask = WorkspaceLinkedItemSchema.nullable()

export function assertLinkedTaskSourceContextMatch(
  value: {
    linkedTask?: z.infer<typeof FolderWorkspaceLinkedTask>
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

export const FolderWorkspaceCreate = z
  .object({
    projectGroupId: requiredString('Missing project group id'),
    name: OptionalString,
    folderPath: OptionalString.nullable().optional(),
    connectionId: OptionalString.nullable().optional(),
    linkedTask: FolderWorkspaceLinkedTask.optional(),
    linkedItems: WorkspaceAttachmentsSchema.optional(),

    linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
    createdWithAgent: RpcString.refine(isTuiAgent).optional(),
    pendingFirstAgentMessageRename: RpcOptionalBoolean
  })
  .superRefine(assertLinkedTaskSourceContextMatch)

export const FolderWorkspaceUpdate = z.object({
  folderWorkspaceId: requiredString('Missing folder workspace id'),
  updates: z
    .object({
      name: OptionalString,
      folderPath: OptionalString,
      linkedTask: FolderWorkspaceLinkedTask.optional(),
      linkedItems: WorkspaceAttachmentsSchema.optional(),
      linkedItemsBase: WorkspaceAttachmentsSchema.optional(),
      linkedItemsSelectionChanged: RpcOptionalBoolean,
      linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
      comment: RpcOptionalString,
      isArchived: RpcOptionalBoolean,
      isUnread: RpcOptionalBoolean,
      isPinned: RpcOptionalBoolean,
      sortOrder: OptionalFiniteNumber,
      manualOrder: OptionalFiniteNumber,
      workspaceStatus: OptionalString,
      createdWithAgent: RpcString.refine(isTuiAgent).optional(),
      pendingFirstAgentMessageRename: RpcOptionalBoolean,
      firstAgentMessageRenameError: RpcOptionalNullableString,
      lastActivityAt: OptionalFiniteNumber,
      diffComments: z.array(DiffCommentSchema).optional()
    })
    .superRefine(assertLinkedTaskSourceContextMatch)
})

export const FolderWorkspaceSelector = z.object({
  folderWorkspaceId: requiredString('Missing folder workspace id')
})

export const FolderWorkspacePathStatus = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('folder-workspace'),
    folderWorkspaceId: requiredString('Missing folder workspace id')
  }),
  z.object({
    scope: z.literal('project-group'),
    projectGroupId: requiredString('Missing project group id')
  }),
  z.object({
    scope: z.literal('path'),
    path: requiredString('Missing folder path'),
    connectionId: OptionalString.nullable().optional()
  })
])
