import { commitHibernatedPane } from './terminal-pane-hibernation-commit'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  restorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers
} from '@/components/terminal-pane/pty-dispatcher'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import '../slices/agent-status/agent-status'
import {
  collectHibernatedCompletionEvidenceForWorktree,
  collectSleepingAgentSessionRecordsForWorktree
} from '../slices/agent-status/agent-status-recovery-collection'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { equalStringSets, sortedUniquePtyIds } from './terminal-pty-identities'
import { resolveTerminalPtyOwner } from '@/lib/terminal-worktree-route'
import { resolveTerminalTeardownOwner } from './terminal-teardown-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { recordPaneSleepThroughLayoutOwner } from './terminal-sleep-layout-owner'

export function createTerminalPaneHibernationActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'shutdownCompletedAgentPaneForHibernation'> {
  return {
    shutdownCompletedAgentPaneForHibernation: async (worktreeId, opts) => {
      const paneKeys = [opts.paneKey]
      const expectedRuntimePtyIds = sortedUniquePtyIds(
        opts.expectedRuntimePtyId ? [opts.expectedRuntimePtyId] : []
      )
      const rendererShutdownPtyIds = [opts.ptyId]
      const state = get()
      const worktreeOwner = resolveTerminalPtyOwner(state, worktreeId)
      const teardownOwner = resolveTerminalTeardownOwner(worktreeOwner, [opts.ptyId])
      // Use PTY owner for twins; losing bindings without an attributable host stop leaves unseen running agents.
      if (
        teardownOwner.kind === 'refused' ||
        (worktreeOwner.kind === 'ambiguous' &&
          isRemoteRuntimePtyId(opts.ptyId) &&
          expectedRuntimePtyIds.length === 0)
      ) {
        console.warn('[agent-hibernation] refusing pane hibernation: terminal owner is ambiguous', {
          worktreeId,
          paneKey: opts.paneKey
        })
        throw new Error('ambiguous_terminal_owner')
      }
      const runtimeEnvironmentId = teardownOwner.runtimeEnvironmentId
      // Why: pane transports emit renderer PTY ids, not raw exact-stop handles; guard only the identity that can deliver an exit callback.
      const exitGuardPtyIds = [opts.ptyId]
      const tab = (state.tabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === opts.tabId
      )
      const parsed = parsePaneKey(opts.paneKey)
      const layout = state.terminalLayoutsByTabId[opts.tabId]
      const liveTabPtyIds = state.ptyIdsByTabId[opts.tabId] ?? []
      if (
        !tab ||
        !parsed ||
        parsed.tabId !== opts.tabId ||
        parsed.leafId !== opts.leafId ||
        layout?.ptyIdsByLeafId?.[opts.leafId] !== opts.ptyId ||
        (expectedRuntimePtyIds.length === 0 && !liveTabPtyIds.includes(opts.ptyId))
      ) {
        throw new Error('agent_hibernation_pane_binding_mismatch')
      }
      const sleepingAgentSessionRecords: ReturnType<
        typeof collectSleepingAgentSessionRecordsForWorktree
      > =
        opts.lifecycle?.preservePane === false
          ? {}
          : collectSleepingAgentSessionRecordsForWorktree(state, worktreeId, {
              paneKeys,
              captureMode: 'completed-agent-hibernation'
            })
      const retainedCompletionEvidence = collectHibernatedCompletionEvidenceForWorktree(
        state,
        worktreeId,
        paneKeys
      )
      const preservePane = Boolean(sleepingAgentSessionRecords[opts.paneKey])
      if (!opts.lifecycle && !preservePane) {
        // Why: killing the PTY with no persisted resume record strands the pane unwakeable; abort instead of hibernating unrecoverably.
        throw new Error('agent_hibernation_capture_missing')
      }
      const capture = shutdownBufferCaptures.get(opts.tabId)
      if (capture) {
        try {
          capture({ includeLocalBuffers: false })
        } catch {
          // Don't let one tab's capture failure block the pane hibernation.
        }
      }
      // Why: store sleeping records before kill, since pty:exit can arrive first.
      const sleepingRecordKeys = Object.keys(sleepingAgentSessionRecords)
      const replacedSleepingRecords: Record<string, (typeof sleepingAgentSessionRecords)[string]> =
        {}
      for (const key of sleepingRecordKeys) {
        const existing = state.sleepingAgentSessionsByPaneKey[key]
        if (existing) {
          replacedSleepingRecords[key] = existing
        }
      }
      const transactionCurrent = (): boolean => {
        const current = get()
        return (
          current.terminalLayoutsByTabId[opts.tabId]?.ptyIdsByLeafId?.[opts.leafId] ===
            opts.ptyId &&
          (!preservePane ||
            current.sleepingAgentSessionsByPaneKey[opts.paneKey] ===
              sleepingAgentSessionRecords[opts.paneKey])
        )
      }
      const rollbackTargetShutdownState = (): void => {
        set((s) => {
          const next = { ...s.suppressedPtyExitIds }
          for (const ptyId of exitGuardPtyIds) {
            if (
              !state.suppressedPtyExitIds[ptyId] &&
              s.terminalLayoutsByTabId[opts.tabId]?.ptyIdsByLeafId?.[opts.leafId] === opts.ptyId &&
              (!sleepingRecordKeys.length ||
                s.sleepingAgentSessionsByPaneKey[opts.paneKey] ===
                  sleepingAgentSessionRecords[opts.paneKey])
            ) {
              delete next[ptyId]
            }
          }
          const nextSleeping = { ...s.sleepingAgentSessionsByPaneKey }
          for (const key of sleepingRecordKeys) {
            if (nextSleeping[key] !== sleepingAgentSessionRecords[key]) {
              continue
            }
            const replaced = replacedSleepingRecords[key]
            if (replaced) {
              nextSleeping[key] = replaced
            } else {
              delete nextSleeping[key]
            }
          }
          return { suppressedPtyExitIds: next, sleepingAgentSessionsByPaneKey: nextSleeping }
        })
      }
      set((s) => ({
        suppressedPtyExitIds: {
          ...s.suppressedPtyExitIds,
          ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
        },
        sleepingAgentSessionsByPaneKey: {
          ...s.sleepingAgentSessionsByPaneKey,
          ...sleepingAgentSessionRecords
        }
      }))
      if (expectedRuntimePtyIds.length > 0) {
        if (!runtimeEnvironmentId) {
          rollbackTargetShutdownState()
          throw new Error('missing_runtime_for_exact_terminal_stop')
        }
        let stopResult: {
          stoppedPtyIds?: string[]
          livePtyIds?: string[]
          postStopVerified?: boolean
          postStopFailure?: string
        }
        try {
          stopResult = await callRuntimeRpc<{
            stoppedPtyIds?: string[]
            livePtyIds?: string[]
            postStopVerified?: boolean
            postStopFailure?: string
          }>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'terminal.stopExact',
            {
              worktree: toRuntimeWorktreeSelector(worktreeId),
              expectedPtyIds: expectedRuntimePtyIds,
              keepHistory: true,
              targetOnly: true
            },
            { timeoutMs: 15000 }
          )
        } catch (err) {
          rollbackTargetShutdownState()
          throw err
        }
        const stoppedPtyIds = sortedUniquePtyIds(stopResult.stoppedPtyIds)
        const livePtyIds = sortedUniquePtyIds(stopResult.livePtyIds)
        const targetWasLive = expectedRuntimePtyIds.every((ptyId) => livePtyIds.includes(ptyId))
        if (!equalStringSets(stoppedPtyIds, expectedRuntimePtyIds) || !targetWasLive) {
          rollbackTargetShutdownState()
          throw new Error('exact_terminal_stop_mismatch')
        }
        if (stopResult.postStopVerified !== true) {
          rollbackTargetShutdownState()
          throw new Error(stopResult.postStopFailure ?? 'exact_terminal_stop_unverified')
        }
        for (const snapshot of unregisterPtyDataHandlers(rendererShutdownPtyIds) ?? []) {
          snapshot.commit?.()
        }
      } else if (!isRemoteRuntimePtyId(opts.ptyId)) {
        // Why: pty.kill can flush final data before exit; unregister first so stale handlers can't fire phantom notifications during hibernation.
        const handlerSnapshots = unregisterPtyDataHandlers(rendererShutdownPtyIds) ?? []
        try {
          if (opts.lifecycle) {
            const proof = await opts.lifecycle.stop(preservePane, transactionCurrent)
            if (proof === 'unproven') {
              throw new Error('terminal_stop_unproven')
            }
            if (proof !== 'stopped') {
              throw new Error('terminal_stop_still_live')
            }
          } else {
            await window.api.pty.kill(opts.ptyId, { keepHistory: true })
          }
        } catch (err) {
          if (opts.lifecycle && err instanceof Error && err.message === 'terminal_stop_unproven') {
            restorePtyDataHandlersAfterFailedShutdown(handlerSnapshots)
            throw err
          }
          restorePtyDataHandlersAfterFailedShutdown(handlerSnapshots)
          rollbackTargetShutdownState()
          throw err
        }
        for (const snapshot of handlerSnapshots) {
          snapshot.commit?.()
        }
      }
      if (opts.lifecycle) {
        if (!transactionCurrent()) {
          throw new Error('terminal_sleep_binding_changed')
        }
        if (!preservePane) {
          return
        }
      }
      // Switch point: main records the sleep this window decided, once the stop settled.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        recordPaneSleepThroughLayoutOwner(get(), worktreeId, sleepingAgentSessionRecords)
      }
      commitHibernatedPane({
        set,
        get,
        worktreeId,
        opts,
        state,
        rendererShutdownPtyIds,
        exitGuardPtyIds
      })
      if (
        opts.lifecycle &&
        get().agentStatusByPaneKey[opts.paneKey] !== state.agentStatusByPaneKey[opts.paneKey]
      ) {
        return
      }
      get().dropHibernatedAgentStatusPane(worktreeId, opts.paneKey, {
        retainedCompletionEvidence
      })
    }
  }
}
