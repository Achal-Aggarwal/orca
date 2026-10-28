import { ipcMain } from 'electron'
import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { getBranchDiff, getCommitDiff } from '../../git/status'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import { validateFullGitObjectId, validateGitRelativeFilePath } from './filesystem-path-containment'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'

export function registerFilesystemGitDiffHandlers(context: FilesystemHandlerContext): void {
  const { store, gitReadCancellations } = context
  ipcMain.handle('git:cancelDiff', (event, args: { requestToken: string }): void => {
    gitReadCancellations.cancel(event, args.requestToken)
  })

  ipcMain.handle(
    'git:branchDiff',
    async (
      event,
      args: {
        worktreePath: string
        compare: {
          baseRef: string
          baseOid: string
          headOid: string
          mergeBase: string
        }
        filePath: string
        oldPath?: string
        connectionId?: string
        requestToken?: string
      }
    ): Promise<GitDiffResult> => {
      const controller = gitReadCancellations.begin(event, args.requestToken)
      try {
        requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
        const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
        const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
        const oldPath = args.oldPath
          ? validateGitRelativeFilePath(worktreePath, args.oldPath)
          : undefined
        const gitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.worktreePath,
          worktreePath
        )
        return await getBranchDiff(
          worktreePath,
          {
            mergeBase: args.compare.mergeBase,
            headOid: args.compare.headOid,
            filePath,
            oldPath
          },
          {
            ...gitOptions,
            admissionTier: 'interactive',
            ...(controller ? { signal: controller.signal } : {})
          }
        )
      } finally {
        gitReadCancellations.finish(event, args.requestToken, controller)
      }
    }
  )

  ipcMain.handle(
    'git:commitDiff',
    async (
      event,
      args: {
        worktreePath: string
        commitOid: string
        parentOid?: string | null
        filePath: string
        oldPath?: string
        connectionId?: string
        requestToken?: string
      }
    ): Promise<GitDiffResult> => {
      const controller = gitReadCancellations.begin(event, args.requestToken)
      try {
        const commitOid = validateFullGitObjectId(args.commitOid, 'commitOid')
        const parentOid = args.parentOid
          ? validateFullGitObjectId(args.parentOid, 'parentOid')
          : null
        requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
        const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
        const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
        const oldPath = args.oldPath
          ? validateGitRelativeFilePath(worktreePath, args.oldPath)
          : undefined
        const gitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.worktreePath,
          worktreePath
        )
        return await getCommitDiff(
          worktreePath,
          {
            commitOid,
            parentOid,
            filePath,
            oldPath
          },
          {
            ...gitOptions,
            admissionTier: 'interactive',
            ...(controller ? { signal: controller.signal } : {})
          }
        )
      } finally {
        gitReadCancellations.finish(event, args.requestToken, controller)
      }
    }
  )
}
