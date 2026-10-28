import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { hasRegisteredRuntimeTerminalTab } from '../../runtime/mounted-terminal-tab-registry'
import { canWatcherCoverParkedTerminalTab } from '../terminal-pane/terminal-parked-tab-watchers'
import { getSleepingRecordTabId } from '@/lib/sleeping-agent-wake-requests'
import { canAdmitTerminalTabsForStartup } from './background-terminal-worktree-mount'
import {
  type TerminalPrewarmStage,
  getTerminalPrewarmWorktrees,
  setHeldTerminalPrewarmWorktrees,
  planTerminalPrewarmTabMount,
  subscribeTerminalPrewarmWorktrees
} from './terminal-worktree-prewarm'
import type { TerminalColdActivationController } from '../terminal-cold-activation'
import { hasRetainedWorkspaceTerminalFrames } from './terminal-worktree-retained-frames'

function selectRevealTerminalTabIds(state: AppState, worktreeId: string): Set<string> {
  const revealTabIds = new Set<string>()
  const unifiedTabById = new Map(
    (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab])
  )
  for (const group of state.groupsByWorktree[worktreeId] ?? []) {
    const tab = group.activeTabId ? unifiedTabById.get(group.activeTabId) : undefined
    if (tab?.contentType === 'terminal') {
      revealTabIds.add(tab.entityId)
    }
  }
  const rememberedTabId = state.activeTabIdByWorktree[worktreeId]
  if (revealTabIds.size === 0 && rememberedTabId) {
    revealTabIds.add(rememberedTabId)
  }
  return revealTabIds
}

function selectSleepingTabIds(state: AppState, worktreeId: string): Set<string> {
  const tabIds = new Set<string>()
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    const tabId = record.worktreeId === worktreeId ? getSleepingRecordTabId(record) : null
    if (tabId) {
      tabIds.add(tabId)
    }
  }
  return tabIds
}

// Each stage waits for an idle slot after the previous commit; the timeout keeps it ready before a typical press.
function scheduleTerminalPrewarmStage(callback: () => void): () => void {
  if (typeof requestIdleCallback !== 'function') {
    const timer = setTimeout(callback, 16)
    return () => clearTimeout(timer)
  }
  const handle = requestIdleCallback(callback, { timeout: 60 })
  return () => cancelIdleCallback(handle)
}

type PrewarmLease = {
  cancelNextStage: (() => void) | null
  // Hovered leases stay laid out for the press; neighbor-only leases settle hidden once warm.
  hovered: boolean
  /** Set when the lease narrowed a live, unrestricted mount; release hands those panes back. */
  narrowedLiveMount: {
    allowedTabIds: ReadonlySet<string>
    deferredTabIds: ReadonlySet<string>
  } | null
}

/**
 * Hold prewarmed workspaces' revealable terminals mounted so a switch reveals them at hot cost.
 * Hover keeps its target laid out; a neighbor is mounted, laid out and warmed once, then hidden but kept unparked.
 */
export function useTerminalWorktreePrewarm(controller: TerminalColdActivationController): void {
  const controllerRef = useRef(controller)
  useLayoutEffect(() => {
    controllerRef.current = controller
  })

  useEffect(() => {
    const leases = new Map<string, PrewarmLease>()
    const bumpRevision = (): void =>
      controllerRef.current.setBackgroundMountRevision((revision) => revision + 1)

    const stopMeasuring = (worktreeId: string): void => {
      const c = controllerRef.current
      c.prewarmLeasesRef.current.delete(worktreeId)
      if (!c.measurableBackgroundWorktreeTimersRef.current.has(worktreeId)) {
        c.measurableBackgroundWorktreeIdsRef.current.delete(worktreeId)
        // Skip the post-measure cool-down: ordinary parking (or the neighbor exemption) decides from here.
        c.measuringTerminalWorktreeIdsRef.current.delete(worktreeId)
      }
      bumpRevision()
    }

    const advance = (
      worktreeId: string,
      lease: PrewarmLease,
      stage: TerminalPrewarmStage
    ): void => {
      controllerRef.current.prewarmLeasesRef.current.set(worktreeId, stage)
      bumpRevision()
      const next = stage === 'mount' ? 'layout' : stage === 'layout' ? 'warm' : null
      if (next === null && lease.hovered) {
        return
      }
      lease.cancelNextStage = scheduleTerminalPrewarmStage(() => {
        lease.cancelNextStage = null
        if (next) {
          advance(worktreeId, lease, next)
        } else {
          stopMeasuring(worktreeId)
        }
      })
    }

    const startMeasuring = (
      worktreeId: string,
      lease: PrewarmLease,
      stage: TerminalPrewarmStage
    ) => {
      lease.cancelNextStage?.()
      controllerRef.current.measurableBackgroundWorktreeIdsRef.current.add(worktreeId)
      advance(worktreeId, lease, stage)
    }

    const release = (worktreeId: string, lease: PrewarmLease): void => {
      lease.cancelNextStage?.()
      leases.delete(worktreeId)
      const narrowed = lease.narrowedLiveMount
      if (narrowed) {
        const c = controllerRef.current
        const restrictions = c.backgroundMountTabIdsByWorktreeRef.current
        // Only undo our own narrowing; activation or another mount may have replaced it since.
        if (restrictions.get(worktreeId) === narrowed.allowedTabIds) {
          restrictions.delete(worktreeId)
        }
        const deferred = c.activationDeferredMountTabIdsByWorktreeRef.current
        const remaining = [...(deferred.get(worktreeId) ?? [])].filter(
          (tabId) => !narrowed.deferredTabIds.has(tabId)
        )
        if (remaining.length > 0) {
          deferred.set(worktreeId, new Set(remaining))
        } else {
          deferred.delete(worktreeId)
        }
      }
      stopMeasuring(worktreeId)
    }

    const lease = (worktreeId: string, hovered: boolean): void => {
      const c = controllerRef.current
      if (
        // Without hidden-view parking nothing unmounts a released lease, so prewarm would pin every target.
        !c.terminalParkingEnabled ||
        worktreeId === c.renderedActiveWorktreeId ||
        !c.workspaceSurfaceIdSet.has(worktreeId) ||
        // Until startup publishes PTY ownership, a hidden mount could duplicate shells.
        !canAdmitTerminalTabsForStartup(c)
      ) {
        return
      }
      const state = useAppStore.getState()
      const mounted = c.mountedWorktreeIdsRef.current.has(worktreeId)
      const restrictions = c.backgroundMountTabIdsByWorktreeRef.current
      const parked = c.effectiveParkedTerminalWorktreeIds.has(worktreeId)
      // A retained surface can hold individually parked tabs; measuring bypasses tab parking, so admit only what the reveal needs.
      const hasNonLiveTab = (state.tabsByWorktree[worktreeId] ?? []).some(
        (tab) => !hasRegisteredRuntimeTerminalTab(tab.id, worktreeId)
      )
      const needsTabPlan = !mounted || restrictions.has(worktreeId) || parked || hasNonLiveTab
      // Narrowing a live unrestricted mount is temporary (undone on release); it also drops the emulator overlay, so leave simulator workspaces alone.
      const narrowsLiveMount = mounted && !restrictions.has(worktreeId) && !parked && hasNonLiveTab
      if (
        narrowsLiveMount &&
        (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
          (tab) => tab.contentType === 'simulator'
        )
      ) {
        return
      }
      let narrowedLiveMount: PrewarmLease['narrowedLiveMount'] = null
      if (needsTabPlan) {
        const sleepingTabIds = selectSleepingTabIds(state, worktreeId)
        const plan = planTerminalPrewarmTabMount({
          tabs: state.tabsByWorktree[worktreeId] ?? [],
          revealTabIds: selectRevealTerminalTabIds(state, worktreeId),
          isTabLive: (tabId) => hasRegisteredRuntimeTerminalTab(tabId, worktreeId),
          isTabRestorable: (tab) => canWatcherCoverParkedTerminalTab(worktreeId, tab),
          isTabSleeping: (tabId) => sleepingTabIds.has(tabId)
        })
        if (!plan) {
          return
        }
        restrictions.set(worktreeId, plan.allowedTabIds)
        const deferred = c.activationDeferredMountTabIdsByWorktreeRef.current
        if (narrowsLiveMount) {
          const alreadyDeferred = deferred.get(worktreeId)
          narrowedLiveMount = {
            allowedTabIds: plan.allowedTabIds,
            deferredTabIds: new Set(
              [...plan.deferredTabIds].filter((tabId) => !alreadyDeferred?.has(tabId))
            )
          }
        }
        const nextDeferred = new Set([...(deferred.get(worktreeId) ?? []), ...plan.deferredTabIds])
        for (const tabId of plan.allowedTabIds) {
          nextDeferred.delete(tabId)
        }
        if (nextDeferred.size > 0) {
          deferred.set(worktreeId, nextDeferred)
        } else {
          deferred.delete(worktreeId)
        }
        c.mountedWorktreeIdsRef.current.add(worktreeId)
      }
      const next: PrewarmLease = { cancelNextStage: null, hovered, narrowedLiveMount }
      leases.set(worktreeId, next)
      if (needsTabPlan) {
        startMeasuring(worktreeId, next, 'mount')
      } else if (hovered || !hasRetainedWorkspaceTerminalFrames(worktreeId)) {
        startMeasuring(worktreeId, next, 'layout')
      }
      // A neighbor already holding revealable frames only needs the parking exemption.
    }

    const sync = (): void => {
      const wanted = getTerminalPrewarmWorktrees()
      for (const [worktreeId, existing] of Array.from(leases)) {
        if (!wanted.has(worktreeId)) {
          release(worktreeId, existing)
        }
      }
      for (const [worktreeId, clients] of wanted) {
        const hovered = clients.has('hover')
        const existing = leases.get(worktreeId)
        if (!existing) {
          lease(worktreeId, hovered)
        } else if (hovered !== existing.hovered) {
          existing.hovered = hovered
          if (hovered) {
            startMeasuring(worktreeId, existing, 'layout')
          } else if (existing.cancelNextStage === null) {
            stopMeasuring(worktreeId)
          }
        }
      }
      // Read by the parking pass this sync's revision bump schedules.
      setHeldTerminalPrewarmWorktrees(leases.keys())
    }
    sync()
    const unsubscribe = subscribeTerminalPrewarmWorktrees(sync)
    return () => {
      unsubscribe()
      for (const [worktreeId, existing] of Array.from(leases)) {
        release(worktreeId, existing)
      }
      setHeldTerminalPrewarmWorktrees([])
    }
  }, [])
}
