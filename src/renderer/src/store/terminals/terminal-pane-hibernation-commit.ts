import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { removePanesAttention } from '../slices/workspace-attention/subject-attention-transitions'
import { settleAttentionRemovedBy } from '../slices/workspace-attention/attention-removal-follow-up'

export function commitHibernatedPane({
  set,
  get,
  worktreeId,
  opts,
  state,
  rendererShutdownPtyIds,
  exitGuardPtyIds
}: {
  set: TerminalStoreSet
  get: TerminalStoreGet
  worktreeId: string
  opts: Parameters<TerminalSlice['shutdownCompletedAgentPaneForHibernation']>[1]
  state: ReturnType<TerminalStoreGet>
  rendererShutdownPtyIds: string[]
  exitGuardPtyIds: string[]
}): void {
  settleAttentionRemovedBy(set, get, () =>
    set((s) => {
      const existingPtyIds = s.ptyIdsByTabId[opts.tabId] ?? []
      const shutdownPtyIdSet = new Set(rendererShutdownPtyIds)
      const remainingPtyIds = existingPtyIds.filter((ptyId) => !shutdownPtyIdSet.has(ptyId))
      const nextTabsByWorktree = { ...s.tabsByWorktree }
      const tabs = nextTabsByWorktree[worktreeId] ?? []
      const tabIndex = tabs.findIndex((candidate) => candidate.id === opts.tabId)
      if (tabIndex !== -1) {
        const nextTabs = [...tabs]
        nextTabs[tabIndex] = {
          ...nextTabs[tabIndex],
          ptyId: remainingPtyIds.at(-1) ?? null
        }
        nextTabsByWorktree[worktreeId] = nextTabs
      }
      const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
      for (const ptyId of exitGuardPtyIds) {
        delete nextCodexRestartNoticeByPtyId[ptyId]
      }
      const nextLastKnownRelay =
        remainingPtyIds.length === 0
          ? { ...s.lastKnownRelayPtyIdByTabId }
          : s.lastKnownRelayPtyIdByTabId
      if (remainingPtyIds.length === 0) {
        delete nextLastKnownRelay[opts.tabId]
      }
      let nextRuntimePaneTitlesByTabId = s.runtimePaneTitlesByTabId
      const numericPaneId = Number(opts.leafId)
      if (
        Number.isInteger(numericPaneId) &&
        s.runtimePaneTitlesByTabId[opts.tabId]?.[numericPaneId]
      ) {
        const nextByPane = { ...s.runtimePaneTitlesByTabId[opts.tabId] }
        delete nextByPane[numericPaneId]
        nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
        if (Object.keys(nextByPane).length > 0) {
          nextRuntimePaneTitlesByTabId[opts.tabId] = nextByPane
        } else {
          delete nextRuntimePaneTitlesByTabId[opts.tabId]
        }
      }
      const nextLastTerminalInputAtByPaneKey = { ...s.lastTerminalInputAtByPaneKey }
      if (
        !opts.lifecycle ||
        s.lastTerminalInputAtByPaneKey[opts.paneKey] ===
          state.lastTerminalInputAtByPaneKey[opts.paneKey]
      ) {
        delete nextLastTerminalInputAtByPaneKey[opts.paneKey]
      }
      return {
        tabsByWorktree: nextTabsByWorktree,
        ptyIdsByTabId: {
          ...s.ptyIdsByTabId,
          [opts.tabId]: remainingPtyIds
        },
        lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
        suppressedPtyExitIds: {
          ...s.suppressedPtyExitIds,
          ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
        },
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
        ...(nextRuntimePaneTitlesByTabId !== s.runtimePaneTitlesByTabId
          ? { runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId }
          : {}),
        ...removePanesAttention(s, new Set([opts.paneKey])),
        lastTerminalInputAtByPaneKey: nextLastTerminalInputAtByPaneKey
      }
    })
  )
}
