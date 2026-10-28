import { RpcNull, RpcNumber, RpcOptionalBoolean, RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import { isTerminalLeafId } from '../stable-pane-id'
import { SleepCommand, StartPaneCommand, WakeCommand } from './workspace-layout-sleep-wake-params'
import { RenameTabsCommand } from './workspace-layout-rename-tabs-params'
import { EditorFileRecord, EditorViewRecord } from './workspace-layout-editor-file-params'
import { SetGroupRatiosCommand, SetPaneRatiosCommand } from './workspace-layout-ratio-params'
import {
  ApplyDefaultTabsCommand,
  CreateTerminalTabCommand,
  NewGroupSplit
} from './workspace-layout-terminal-tab-params'

export const LayoutSubscribeParams = z
  .object({
    /** Workspace keys to receive; every workspace when absent or 'all'. */
    workspaces: z.union([z.literal('all'), z.array(RpcString.min(1))]).optional()
  })
  .nullish()

export const LayoutUnsubscribeParams = z.object({
  subscriptionId: RpcString.min(1, 'Missing subscriptionId')
})

/** A paired desktop's view of the server's workspaces: each one's shown group, null for none. */
export const LayoutReportViewParams = z.object({
  activeGroupByWorkspace: z.record(RpcString.min(1), RpcString.min(1).nullable()),
  /** A re-send after a reconnect, not a change the user made: it never outranks a live report. */
  refresh: z.literal(true).optional()
})

const OnPane = {
  workspace: RpcString.min(1),
  tabId: RpcString.min(1),
  leafId: RpcString.min(1)
}

/** `newLeafId`: a pane the window already split under its own id (a tab's startup splits). */
const SplitPaneCommand = z.object({
  type: z.literal('splitPane'),
  ...OnPane,
  direction: z.enum(['horizontal', 'vertical']),
  newLeafId: RpcString.refine(isTerminalLeafId).optional()
})

/** Main marks a close as the user's; the window cannot send that mark. */
const ClosePaneCommand = z.object({ type: z.literal('closePane'), ...OnPane })

/** A title is trimmed and non-empty; null clears it. */
const RenamePaneCommand = z.object({
  type: z.literal('renamePane'),
  ...OnPane,
  title: z.union([RpcString.trim().min(1), RpcNull])
})

const MovePaneCommand = z.object({
  type: z.literal('movePane'),
  ...OnPane,
  targetLeafId: RpcString.min(1),
  side: z.enum(['left', 'right', 'top', 'bottom'])
})

/** The pane a tab's chat view shows; null clears it. */
const SetChatPaneCommand = z.object({
  type: z.literal('setChatPane'),
  workspace: OnPane.workspace,
  tabId: OnPane.tabId,
  leafId: z.union([RpcString.min(1), RpcNull])
})

const EqualizePanesCommand = z.object({
  type: z.literal('equalizePanes'),
  workspace: OnPane.workspace,
  tabId: OnPane.tabId
})

const OnTab = { workspace: OnPane.workspace, tabId: OnPane.tabId }

/** Within one group too: a reorder is a move to the tab's own group. */
const MoveTabCommand = z.object({
  type: z.literal('moveTab'),
  ...OnTab,
  toGroupId: RpcString.min(1),
  index: RpcNumber.int().nonnegative(),
  // Optional so an older main still takes the move; it places by `index`.
  afterTabId: z.union([RpcString.min(1), RpcNull]).optional(),
  isPinned: RpcOptionalBoolean
})

/** Main mints the new group's id, or moves a lone tab's group whole. */
const SplitGroupCommand = z.object({
  type: z.literal('splitGroup'),
  ...OnTab,
  besideGroupId: RpcString.min(1),
  direction: z.enum(['left', 'right', 'up', 'down'])
})

/** Record terminal closes with the window’s reason; editor closes leave no terminal record. */
const CloseTabsCommand = z.object({
  type: z.literal('closeTabs'),
  workspace: OnPane.workspace,
  tabIds: z.tuple([RpcString.min(1)]),
  recordClose: z.enum(['user', 'cleanup']).optional()
})

/** Use window-proposed editor IDs, rejecting collisions; placement/preview replacement follows window rules. */
const OpenEditorTabCommand = z.object({
  type: z.literal('openEditorTab'),
  ...OnTab,
  fileId: RpcString.min(1),
  contentType: z.enum(['editor', 'diff', 'conflict-review', 'check-details']),
  file: EditorFileRecord.optional(),
  view: EditorViewRecord.optional(),
  groupId: RpcString.min(1).optional(),
  /** Where in the group a reopened tab goes back to. */
  index: RpcNumber.int().nonnegative().optional(),
  preview: z.literal(true).optional(),
  createdAt: RpcNumber.int().nonnegative().optional(),
  split: NewGroupSplit
})

/** A window's drag-out of one pane into a new tab; main mints the tab's id. */
const MovePaneToNewTabCommand = z.object({
  type: z.literal('movePaneToNewTab'),
  ...OnPane,
  groupId: RpcString.min(1),
  index: RpcNumber.int().nonnegative().optional(),
  /** The terminal the window's pane shows now, when it has one. */
  windowDetach: z.object({
    ptyId: RpcString.min(1).max(512).nullable(),
    /** The pane's folder, where an unbound pane's new shell starts. */
    startupCwd: RpcString.min(1).optional()
  })
})

const AiVaultTitle = z.object({
  agent: z.enum(['claude', 'codex']),
  sessionId: RpcString,
  title: RpcString
})

/** A tab's rename: a title as the window stores it today; null clears it. */
const RenameTabCommand = z.discriminatedUnion('kind', [
  z.object({
    type: z.literal('renameTab'),
    ...OnTab,
    kind: z.enum(['custom', 'generated']),
    title: z.union([RpcString, RpcNull]),
    expected: z
      .object({ entityId: RpcString, executionHostId: RpcString, customTitle: RpcString })
      .optional()
  }),
  z.object({
    type: z.literal('renameTab'),
    ...OnTab,
    kind: z.literal('aiVault'),
    title: z.union([AiVaultTitle, RpcNull])
  })
])

const SetTabPropsCommand = z.object({
  type: z.literal('setTabProps'),
  ...OnTab,
  color: z.union([RpcString, RpcNull]).optional(),
  isPinned: RpcOptionalBoolean,
  viewMode: z.enum(['terminal', 'chat']).optional(),
  clearLaunchAgent: z.literal(true).optional()
})

/** Preserve window-created browser tab/page IDs for immediate callers; refuse collisions and replay opens idempotently. */
const OpenBrowserTabCommand = z.object({
  type: z.literal('openBrowserTab'),
  workspace: OnPane.workspace,
  tabId: RpcString.min(1),
  browserTabId: RpcString.min(1),
  pageId: RpcString.min(1),
  profileId: RpcString.min(1).nullable().optional(),
  sessionPartition: RpcString.min(1).nullable().optional(),
  groupId: RpcString.min(1).optional(),
  afterTabId: RpcString.min(1).optional(),
  index: RpcNumber.int().nonnegative().optional(),
  createdAt: RpcNumber.int().nonnegative().optional(),
  browserCreatedAt: RpcNumber.int().nonnegative().optional(),
  split: NewGroupSplit
})

/** Preserve window chat IDs for status/attention; refuse collisions and replay opens idempotently. */
const OpenAgentSessionTabCommand = z.object({
  type: z.literal('openAgentSessionTab'),
  ...OnTab,
  sessionId: RpcString.min(1),
  agent: RpcString.min(1),
  groupId: RpcString.min(1).optional(),
  afterTabId: RpcString.min(1).optional(),
  index: RpcNumber.int().nonnegative().optional(),
  createdAt: RpcNumber.int().nonnegative().optional(),
  split: NewGroupSplit
})

const OnBrowserPage = {
  workspace: OnPane.workspace,
  browserTabId: RpcString.min(1),
  pageId: RpcString.min(1)
}

/** A page the window added to a browser tab, under its own id. */
const OpenBrowserPageCommand = z.object({ type: z.literal('openBrowserPage'), ...OnBrowserPage })

const CloseBrowserPageCommand = z.object({ type: z.literal('closeBrowserPage'), ...OnBrowserPage })

/** A converted page: the window's new page takes the old one's place. */
const ReplaceBrowserPageCommand = z.object({
  type: z.literal('replaceBrowserPage'),
  ...OnBrowserPage,
  newPageId: RpcString.min(1)
})

const SetBrowserTabProfileCommand = z.object({
  type: z.literal('setBrowserTabProfile'),
  workspace: OnPane.workspace,
  browserTabId: RpcString.min(1),
  profileId: RpcString.min(1).nullable(),
  sessionPartition: RpcString.min(1).nullable()
})

const PromotePreviewTabCommand = z.object({ type: z.literal('promotePreviewTab'), ...OnTab })

/** The window applied the workspace's default tabs (or it had none); main records it, once. */
const SetDefaultTabsAppliedCommand = z.object({
  type: z.literal('setDefaultTabsApplied'),
  workspace: OnPane.workspace
})

/** A simulator tab under the id the window drew it with, which is also its entity. */
const OpenSimulatorTabCommand = z.object({
  type: z.literal('openSimulatorTab'),
  ...OnTab,
  groupId: RpcString.min(1).optional(),
  afterTabId: RpcString.min(1).optional(),
  index: RpcNumber.int().nonnegative().optional(),
  createdAt: RpcNumber.int().nonnegative().optional(),
  split: NewGroupSplit
})

/** Move restored editor tabs to the window-resolved owning workspace, preserving proposed IDs (F42). */
const MoveTabToWorkspaceCommand = z.object({
  type: z.literal('moveTabToWorkspace'),
  workspace: OnPane.workspace,
  toWorkspace: RpcString.min(1),
  tabs: z
    .array(
      z.object({
        tabId: RpcString.min(1),
        newTabId: RpcString.min(1),
        newEntityId: RpcString.min(1),
        view: EditorViewRecord.optional()
      })
    )
    .min(1),
  groupId: RpcString.min(1),
  file: EditorFileRecord.optional()
})

/** Apply disk renames to window-proposed editor IDs: move edit records and update non-plain tab view paths. */
const EditorFileRenames = z
  .array(
    z.object({
      fileId: RpcString.min(1),
      newFileId: RpcString.min(1),
      record: z.object({ fromFilePath: RpcString.min(1), file: EditorFileRecord }).optional(),
      view: EditorViewRecord.optional()
    })
  )
  .min(1)

const RenameEditorFilesCommand = z.object({
  type: z.literal('renameEditorFiles'),
  workspace: OnPane.workspace,
  renames: EditorFileRenames,
  /** Other workspaces' renames of the same disk move: all are applied, or none. */
  alsoIn: z
    .array(z.object({ workspace: OnPane.workspace, renames: EditorFileRenames }))
    .min(1)
    .optional()
})

/** Layout-owner command: main mints IDs except window-proposed terminal/browser/editor/chat/simulator tabs,
 * browser pages and groups created by NewGroupSplit. */
export const LayoutApplyParams = z.object({
  command: z.discriminatedUnion('type', [
    CreateTerminalTabCommand,
    SplitPaneCommand,
    ClosePaneCommand,
    RenamePaneCommand,
    EqualizePanesCommand,
    MovePaneCommand,
    SetPaneRatiosCommand,
    SetChatPaneCommand,
    MoveTabCommand,
    SplitGroupCommand,
    SetGroupRatiosCommand,
    CloseTabsCommand,
    RenameTabCommand,
    RenameTabsCommand,
    SetTabPropsCommand,
    MovePaneToNewTabCommand,
    OpenBrowserTabCommand,
    OpenBrowserPageCommand,
    CloseBrowserPageCommand,
    ReplaceBrowserPageCommand,
    SetBrowserTabProfileCommand,
    OpenEditorTabCommand,
    OpenAgentSessionTabCommand,
    PromotePreviewTabCommand,
    OpenSimulatorTabCommand,
    MoveTabToWorkspaceCommand,
    RenameEditorFilesCommand,
    SleepCommand,
    WakeCommand,
    StartPaneCommand,
    SetDefaultTabsAppliedCommand,
    ApplyDefaultTabsCommand
  ])
})
