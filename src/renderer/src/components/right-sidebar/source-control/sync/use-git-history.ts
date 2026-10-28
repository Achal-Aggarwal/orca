import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitHistory } from '@/runtime/runtime-git-status-client'
import { getRuntimeGitScope } from '@/runtime/runtime-git-client-context'
import type { GitHistoryPanelState } from './git-history-panel'
import {
  cacheGitHistoryState,
  pruneGitHistoryCache,
  type GitHistoryCache
} from './git-history-cache'

const EMPTY_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'idle' }

/** Retain recent workspace history; refreshGitHistoryRef avoids callback resubscriptions. */
export function useSourceControlGitHistory({
  activeRepoTarget,
  activeWorktreeId,
  worktreePath,
  compareBaseRef,
  isFolder,
  isBranchVisible,
  isGitHistoryExpanded,
  isGitHistoryVisible,
  worktreeMap
}: {
  activeRepoTarget: RuntimeClientTarget | null
  activeWorktreeId: string | null
  worktreePath: string | null
  compareBaseRef: string | null
  isFolder: boolean
  isBranchVisible: boolean
  isGitHistoryExpanded: boolean
  isGitHistoryVisible: boolean
  worktreeMap: ReadonlyMap<string, unknown>
}): {
  gitHistoryState: GitHistoryPanelState
  refreshGitHistory: () => Promise<void>
  refreshGitHistoryRef: RefObject<() => Promise<void>>
} {
  const [gitHistoryByWorktree, setGitHistoryByWorktree] = useState<GitHistoryCache>(() => new Map())
  const gitHistoryRequestSeqRef = useRef(0)
  const connectionId = activeWorktreeId
    ? (getConnectionId(activeWorktreeId) ?? undefined)
    : undefined
  const ownerKey = JSON.stringify([
    worktreePath,
    activeRepoTarget?.kind,
    activeRepoTarget ? getRuntimeGitScope(activeRepoTarget, connectionId) : null
  ])
  const activeOwnerRef = useRef<{ worktreeId: string | null; key: string } | null>(null)
  const activeEntry = activeWorktreeId ? gitHistoryByWorktree.get(activeWorktreeId) : undefined
  const gitHistoryState =
    activeEntry?.ownerKey === ownerKey ? activeEntry.state : EMPTY_GIT_HISTORY_STATE

  useLayoutEffect(() => {
    activeOwnerRef.current = { worktreeId: activeWorktreeId, key: ownerKey }
    setGitHistoryByWorktree((prev) => {
      let next = prev
      const entry = activeWorktreeId ? prev.get(activeWorktreeId) : undefined
      if (activeWorktreeId && entry && entry.ownerKey !== ownerKey) {
        const filtered = new Map(prev)
        filtered.delete(activeWorktreeId)
        next = filtered
      }
      return pruneGitHistoryCache(next, activeWorktreeId, worktreeMap)
    })
    return () => {
      activeOwnerRef.current = null
    }
  }, [activeWorktreeId, ownerKey, worktreeMap])

  const refreshGitHistory = useCallback(async (): Promise<void> => {
    if (
      !activeWorktreeId ||
      !worktreePath ||
      isFolder ||
      !isBranchVisible ||
      !isGitHistoryExpanded ||
      !isGitHistoryVisible ||
      activeOwnerRef.current?.worktreeId !== activeWorktreeId ||
      activeOwnerRef.current.key !== ownerKey
    ) {
      return
    }
    const worktreeId = activeWorktreeId
    const requestId = gitHistoryRequestSeqRef.current + 1
    gitHistoryRequestSeqRef.current = requestId
    setGitHistoryByWorktree((prev) => {
      const active = activeOwnerRef.current
      if (active?.worktreeId !== worktreeId || active.key !== ownerKey) {
        return prev
      }
      const previous = prev.get(worktreeId)?.state
      return cacheGitHistoryState(
        prev,
        worktreeId,
        ownerKey,
        requestId,
        previous?.result
          ? { status: 'refreshing', result: previous.result }
          : { status: 'loading' },
        worktreeId
      )
    })
    try {
      const result = await getRuntimeGitHistory(
        {
          // Read history on the repo owner, which may differ from the focused host.
          target: requireGitOwnerTarget(activeRepoTarget),
          worktreeId,
          worktreePath,
          connectionId
        },
        { limit: 50, baseRef: compareBaseRef }
      )
      setGitHistoryByWorktree((prev) => {
        const active = activeOwnerRef.current
        const entry = prev.get(worktreeId)
        if (!active || entry?.requestId !== requestId || entry.ownerKey !== ownerKey) {
          return prev
        }
        return cacheGitHistoryState(
          prev,
          worktreeId,
          ownerKey,
          requestId,
          { status: 'ready', result },
          active.worktreeId
        )
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load commits'
      setGitHistoryByWorktree((prev) => {
        const active = activeOwnerRef.current
        const entry = prev.get(worktreeId)
        if (!active || entry?.requestId !== requestId || entry.ownerKey !== ownerKey) {
          return prev
        }
        const previous = entry.state
        return cacheGitHistoryState(
          prev,
          worktreeId,
          ownerKey,
          requestId,
          previous.result
            ? { status: 'error', result: previous.result, error: message }
            : { status: 'error', error: message },
          active.worktreeId
        )
      })
    }
  }, [
    activeRepoTarget,
    activeWorktreeId,
    connectionId,
    compareBaseRef,
    isBranchVisible,
    isFolder,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    ownerKey,
    worktreePath
  ])
  const refreshGitHistoryRef = useRef(refreshGitHistory)
  // Publish before consumer effects, never during render where discarded renders could install callbacks.
  useEffect(() => {
    refreshGitHistoryRef.current = refreshGitHistory
  }, [refreshGitHistory])

  useEffect(() => {
    // Defer Git subprocesses until Commits is expanded and visible, especially for large/remote repos.
    if (!isBranchVisible || !isGitHistoryExpanded || !isGitHistoryVisible) {
      return
    }
    void refreshGitHistoryRef.current()
  }, [
    // History uses compareBaseRef, which can move independently of effectiveBaseRef.
    activeWorktreeId,
    compareBaseRef,
    isBranchVisible,
    isFolder,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    // Owner changes can occur without worktree/path changes; refetch rather than retain another host’s commits.
    ownerKey,
    worktreePath
  ])

  return { gitHistoryState, refreshGitHistory, refreshGitHistoryRef }
}
