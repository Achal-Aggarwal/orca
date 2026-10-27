import type { AppState } from '@/store'
import type { Tab } from '../../../shared/tab-types'
import {
  AGENT_SESSION_SWITCH_CLIENT_MS,
  type SessionSwitchProjection
} from '../../../shared/agent-session-switch-execution'
import { recordWebSessionCloseIntent } from '@/runtime/web-session-close-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-owner'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { createKeptWorktreeSurfacePruners } from '@/store/slices/tabs/kept-worktree-surface-pruning'

type Guard = {
  proposal: SessionSwitchProjection
  workspaceId: string
  tab?: Tab
  placement: string
  used: boolean
  notified: boolean
  releaseClose?: () => void
  retain: (converged?: boolean) => void
}
const guards = new Map<string, Guard>()
function placement(state: Pick<AppState, 'groupsByWorktree'>, workspaceId: string, tab?: Tab) {
  const group = state.groupsByWorktree[workspaceId]?.find((row) => row.id === tab?.groupId)
  return JSON.stringify([
    tab?.id,
    tab?.entityId,
    tab?.groupId,
    group?.tabOrder.indexOf(tab?.id ?? '')
  ])
}

/** Only active handoffs own guards; ordinary tab use never waits for a host receipt. */
export function captureSwitchProjection(
  state: AppState,
  workspaceId: string,
  proposal: SessionSwitchProjection,
  retain: (converged?: boolean) => void
): void {
  const provisional = [...guards.entries()].find(
    ([, guard]) => guard.proposal.invocationId === proposal.invocationId
  )
  const previous = guards.get(proposal.generation) ?? provisional?.[1]
  if (previous && provisional && provisional[0] !== proposal.generation) {
    guards.delete(provisional[0])
    guards.set(proposal.generation, previous)
    previous.proposal = proposal
  }
  if (previous?.proposal.invocationId === proposal.invocationId) {
    previous.retain = retain
    if (previous.used) {
      previous.notified = true
      queueMicrotask(retain)
    }
    return
  }
  for (const [generation, guard] of guards) {
    if (guard.workspaceId !== workspaceId || guard.proposal.sessionId !== proposal.sessionId) {
      continue
    }
    guard.releaseClose?.()
    guard.retain()
    guards.delete(generation)
  }
  const tab = state.unifiedTabsByWorktree[workspaceId]?.find(
    (row) =>
      row.id === proposal.tabId ||
      (row.contentType === 'agent-session' && row.entityId === proposal.sessionId)
  )
  guards.set(proposal.generation, {
    proposal,
    workspaceId,
    tab,
    placement: placement(state, workspaceId, tab),
    used: false,
    notified: false,
    retain
  })
}
export function noteSwitchPresentationUse(tabOrSessionId: string): void {
  for (const guard of guards.values()) {
    if (guard.tab?.id === tabOrSessionId || guard.proposal.sessionId === tabOrSessionId) {
      guard.releaseClose?.()
      guard.used = true
      if (!guard.notified) {
        guard.notified = true
        queueMicrotask(guard.retain)
      }
    }
  }
}
export function observeSwitchProjections(
  state: AppState,
  snapshot: RuntimeMobileSessionTabsResult,
  retain: (proposal: SessionSwitchProjection, converged?: boolean) => void
): void {
  for (const proposal of snapshot.switchProjections ?? []) {
    if (proposal.phase === 'prepare') {
      captureSwitchProjection(state, snapshot.worktree, proposal, (converged) =>
        retain(proposal, converged)
      )
    }
    const guard = guards.get(proposal.generation)
    if (guard) {
      guard.proposal = proposal
      if (proposal.phase === 'retain') {
        guard.releaseClose?.()
      }
    }
  }
}

/** A switch projection changes presentation only, never drafts, readers or provider ownership. */
export function retireSwitchProjection(
  state: AppState,
  proposal: SessionSwitchProjection
): Partial<AppState> | null {
  const guard = guards.get(proposal.generation)
  if (!guard || !guard.tab || guard.used) {
    return null
  }
  const tab = state.unifiedTabsByWorktree[guard.workspaceId]?.find(
    (row) => row.id === guard.tab!.id
  )
  if (!tab || placement(state, guard.workspaceId, tab) !== guard.placement) {
    noteSwitchPresentationUse(proposal.sessionId)
    return null
  }
  const prune = createKeptWorktreeSurfacePruners(state, {
    worktreeIds: new Set([guard.workspaceId]),
    unifiedTabIds: new Set([tab.id]),
    terminalTabIds: new Set(),
    fileIds: new Set(),
    browserTabIds: new Set()
  })
  guard.releaseClose = recordWebSessionCloseIntent(
    { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
    guard.workspaceId,
    `agent-session:${proposal.sessionId}`,
    Date.now(),
    AGENT_SESSION_SWITCH_CLIENT_MS
  )
  return {
    unifiedTabsByWorktree: prune.unifiedTabs(state.unifiedTabsByWorktree),
    groupsByWorktree: prune.groups(state.groupsByWorktree),
    tabBarOrderByWorktree: prune.tabBarOrder(state.tabBarOrderByWorktree),
    activeTabIdByWorktree: prune.activeTabIds(state.activeTabIdByWorktree)
  }
}

/** Recheck inside the actual producer, including prepared patches and later omission frames. */
export function protectSwitchProjections<
  State extends Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree'> &
    Partial<Pick<AppState, 'activeTabIdByWorktree' | 'activeGroupIdByWorktree'>>
>(state: State, patch: Partial<State>): Partial<State> {
  const workspaces = new Map<
    string,
    {
      current: Map<string, Tab>
      present: Set<string>
      placements: Map<string, string>
      restored: Tab[]
    }
  >()
  for (const guard of guards.values()) {
    const rows = patch.unifiedTabsByWorktree?.[guard.workspaceId]
    if (!rows || !guard.tab) {
      continue
    }
    let indexed = workspaces.get(guard.workspaceId)
    if (!indexed) {
      const currentRows = state.unifiedTabsByWorktree[guard.workspaceId] ?? []
      const positions = new Map<string, number>()
      const groupIds = new Set(
        (state.groupsByWorktree[guard.workspaceId] ?? []).map((group) => group.id)
      )
      for (const group of state.groupsByWorktree[guard.workspaceId] ?? []) {
        group.tabOrder.forEach((id, index) => positions.set(id, index))
      }
      indexed = {
        current: new Map(currentRows.map((tab) => [tab.id, tab])),
        present: new Set(rows.map((tab) => tab.id)),
        placements: new Map(
          currentRows.map((tab) => [
            tab.id,
            JSON.stringify([
              tab.id,
              tab.entityId,
              tab.groupId,
              positions.get(tab.id) ?? (groupIds.has(tab.groupId ?? '') ? -1 : undefined)
            ])
          ])
        ),
        restored: []
      }
      workspaces.set(guard.workspaceId, indexed)
    }
    const current = indexed.current.get(guard.tab.id)
    if (current && indexed.placements.get(current.id) !== guard.placement) {
      guard.releaseClose?.()
      guard.used = true
    }
    const present = indexed.present.has(guard.tab.id)
    if (
      (guard.proposal.phase === 'retain' && present) ||
      (guard.proposal.phase === 'retire' && !guard.used && !present)
    ) {
      guard.releaseClose?.()
      guards.delete(guard.proposal.generation)
      queueMicrotask(() => guard.retain(true))
      continue
    }
    if (!guard.used || present) {
      continue
    }
    if (!guard.notified) {
      guard.notified = true
      queueMicrotask(guard.retain)
    }
    const kept = current ?? guard.tab
    indexed.restored.push(kept)
    indexed.present.add(kept.id)
  }
  let next = patch
  for (const [workspaceId, indexed] of workspaces) {
    if (!indexed.restored.length) {
      continue
    }
    const currentGroups = new Map(
      (state.groupsByWorktree[workspaceId] ?? []).map((group) => [group.id, group])
    )
    const additions = new Map<string, string[]>()
    for (const tab of indexed.restored) {
      if (!tab.groupId) {
        continue
      }
      const ids = additions.get(tab.groupId) ?? []
      ids.push(tab.id)
      additions.set(tab.groupId, ids)
    }
    const groups = (
      patch.groupsByWorktree?.[workspaceId] ??
      state.groupsByWorktree[workspaceId] ??
      []
    ).map((group) => {
      const ids = additions.get(group.id)
      additions.delete(group.id)
      if (!ids) {
        return group
      }
      const present = new Set(group.tabOrder)
      return { ...group, tabOrder: [...group.tabOrder, ...ids.filter((id) => !present.has(id))] }
    })
    for (const id of additions.keys()) {
      const group = currentGroups.get(id)
      if (group) {
        groups.push(group)
      }
    }
    next = {
      ...next,
      unifiedTabsByWorktree: {
        ...(next.unifiedTabsByWorktree ?? state.unifiedTabsByWorktree),
        [workspaceId]: [...(patch.unifiedTabsByWorktree?.[workspaceId] ?? []), ...indexed.restored]
      },
      groupsByWorktree: {
        ...(next.groupsByWorktree ?? state.groupsByWorktree),
        [workspaceId]: groups
      },
      ...(indexed.restored.some((tab) => state.activeTabIdByWorktree?.[workspaceId] === tab.id)
        ? {
            activeTabIdByWorktree: {
              ...next.activeTabIdByWorktree,
              ...state.activeTabIdByWorktree
            },
            activeGroupIdByWorktree: {
              ...next.activeGroupIdByWorktree,
              ...state.activeGroupIdByWorktree
            }
          }
        : {})
    }
  }
  return next
}

/** Teardown retains unresolved sources before releasing this view's transient protection. */
export function disposeSwitchProjections(): void {
  for (const guard of guards.values()) {
    guard.releaseClose?.()
    guard.retain()
  }
  guards.clear()
}

export function releaseUnsentSwitchProjection(invocationId: string): void {
  const guard = guards.get(invocationId)
  if (guard?.proposal.invocationId === invocationId) {
    guards.delete(invocationId)
  }
}
