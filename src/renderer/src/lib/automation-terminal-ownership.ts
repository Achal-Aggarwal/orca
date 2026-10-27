import {
  automationTerminalLifecycleResponse,
  isCurrentAutomationTerminalRequest
} from '../../../shared/automation-terminal-lifecycle'
import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import type {
  AutomationTerminalLifecycleOwner,
  AutomationTerminalTarget,
  AutomationTerminalLifecycleResponse
} from '../../../shared/automation-terminal-lifecycle'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { mobilePublicationEpoch } from '@/runtime/sync-runtime-graph/graph-state'
import { readLastTerminalInputAt } from './terminal-input-activity-coalescing'
import { persistWorkspaceSessionByHost } from './workspace-session-host-persistence'
import { buildWorkspaceSessionPayload } from './workspace-session'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { isUnifiedTabPinned } from '@/store/pinned-tab-close-guard'

export type AutomationTerminalOwnershipStore = {
  getState: () => AppState
  subscribe: (listener: (state: AppState, previousState: AppState) => void) => () => void
}

function isOwnedTabIdentityCurrent(
  state: AppState,
  args: AutomationTerminalTarget & { ptyId: string; tabCreatedAt: number }
): boolean {
  const parsedPane = parsePaneKey(args.paneKey)
  if (!parsedPane || parsedPane.tabId !== args.tabId) {
    return false
  }
  const matchingTabs = Object.entries(state.tabsByWorktree).flatMap(([worktreeId, tabs]) =>
    tabs.filter((tab) => tab.id === args.tabId).map((tab) => ({ tab, worktreeId }))
  )
  const match = matchingTabs[0]
  if (
    matchingTabs.length !== 1 ||
    !match ||
    match.worktreeId !== args.worktreeId ||
    match.tab.worktreeId !== args.worktreeId ||
    match.tab.createdAt !== args.tabCreatedAt
  ) {
    return false
  }
  if (match.tab.ptyId !== null && match.tab.ptyId !== args.ptyId) {
    return false
  }
  if ((state.ptyIdsByTabId[args.tabId] ?? []).some((ptyId) => ptyId !== args.ptyId)) {
    return false
  }
  const layout = state.terminalLayoutsByTabId[args.tabId]
  const root = layout?.root
  const ptyIdsByLeafId = layout?.ptyIdsByLeafId
  if (
    !layout ||
    !root ||
    root.type !== 'leaf' ||
    root.leafId !== parsedPane.leafId ||
    layout.activeLeafId !== parsedPane.leafId ||
    Object.keys(ptyIdsByLeafId ?? {}).some((leafId) => leafId !== parsedPane.leafId)
  ) {
    return false
  }
  const layoutPtyId = ptyIdsByLeafId?.[parsedPane.leafId]
  return layoutPtyId === undefined || layoutPtyId === args.ptyId
}

export function createAutomationTerminalOwnership(
  store: AutomationTerminalOwnershipStore,
  target: AutomationTerminalTarget
) {
  let taken = false
  let lost = false
  let materialized = false
  let createdAt = 0
  let ptyId: string | null = null
  const initial = store.getState()
  const input = readLastTerminalInputAt(initial.lastTerminalInputAtByPaneKey, target.paneKey)
  let tabs = initial.tabsByWorktree[target.worktreeId]
  let layout = initial.terminalLayoutsByTabId[target.tabId]
  let ptys = initial.ptyIdsByTabId[target.tabId]
  // Enrollment cannot infer the history of a surface that already existed.
  if (tabs?.some((tab) => tab.id === target.tabId)) {
    lost = true
  }
  const observe = (state: AppState): void => {
    taken ||=
      (state.activeWorktreeId === target.worktreeId &&
        state.activeTabId === target.tabId &&
        state.activeTabType === 'terminal') ||
      readLastTerminalInputAt(state.lastTerminalInputAtByPaneKey, target.paneKey) !== input
    const nextTabs = state.tabsByWorktree[target.worktreeId]
    const nextLayout = state.terminalLayoutsByTabId[target.tabId]
    const nextPtys = state.ptyIdsByTabId[target.tabId]
    if (tabs === nextTabs && layout === nextLayout && ptys === nextPtys) {
      return
    }
    tabs = nextTabs
    layout = nextLayout
    ptys = nextPtys
    const tab = tabs?.find((candidate) => candidate.id === target.tabId)
    if (!materialized && tab) {
      materialized = true
      createdAt = tab.createdAt
    } else if (materialized && (!tab || tab.createdAt !== createdAt)) {
      lost = true
    }
    if (ptyId && !isOwnedTabIdentityCurrent(state, { ...target, ptyId, tabCreatedAt: createdAt })) {
      lost = true
    }
  }
  const release = store.subscribe(observe)
  observe(initial)
  const eligible = (): boolean => {
    observe(store.getState())
    return (
      !taken &&
      !lost &&
      materialized &&
      ptyId !== null &&
      isOwnedTabIdentityCurrent(store.getState(), { ...target, ptyId, tabCreatedAt: createdAt })
    )
  }
  return {
    release,
    eligible,
    bind: (original: string): boolean => {
      if (ptyId || isRemoteRuntimePtyId(original)) {
        return false
      }
      ptyId = original
      return eligible()
    }
  }
}

export function registerAutomationTerminalLifecycle(
  store: AutomationTerminalOwnershipStore = useAppStore
): () => void {
  const api = window.api.automations
  if (!api.onTerminalLifecycleRequest) {
    return () => {}
  }
  const owners = new Map<
    string,
    AutomationTerminalLifecycleOwner<ReturnType<typeof createAutomationTerminalOwnership>>
  >()
  const persist = async (): Promise<void> => {
    const state = store.getState()
    await persistWorkspaceSessionByHost(
      window.api.session,
      buildWorkspaceSessionPayload(state),
      state
    )
  }
  const dispose = (id: string): void => {
    const owner = owners.get(id)
    owners.delete(id)
    owner?.ownership.release()
    owner?.settle?.(owner.authorized ? 'unproven' : 'live')
  }
  const release = api.onTerminalLifecycleRequest((request) => {
    const respond = (disposition: AutomationTerminalLifecycleResponse['disposition']): void =>
      api.respondTerminalLifecycle(
        automationTerminalLifecycleResponse(request, mobilePublicationEpoch, disposition)
      )
    if (request.operation === 'arm') {
      if (owners.has(request.registrationId) || request.documentEpoch !== null) {
        respond('kept')
        return
      }
      owners.set(request.registrationId, {
        request,
        target: request.target,
        ownership: createAutomationTerminalOwnership(store, request.target),
        ptyId: null,
        prepared: false,
        authorized: false
      })
      respond('armed')
      return
    }
    const owner = owners.get(request.registrationId)
    if (!isCurrentAutomationTerminalRequest(owner, request, mobilePublicationEpoch)) {
      respond('kept')
      return
    }
    if (request.operation === 'release') {
      dispose(request.registrationId)
      respond('released')
      return
    }
    if (request.operation === 'bind') {
      if (owner.ptyId || !owner.ownership.bind(request.ptyId)) {
        respond('kept')
        return
      }
      owner.ptyId = request.ptyId
      respond('bound')
      return
    }
    if (request.phase === 'authorize') {
      const allowed =
        owner.prepared &&
        !owner.authorized &&
        owner.transactionCurrent?.() === true &&
        owner.ownership.eligible()
      owner.authorized ||= allowed
      respond(allowed ? 'authorized' : 'kept')
      return
    }
    if (request.phase === 'stop-settled') {
      if (!owner.prepared || !owner.completion || !owner.settle) {
        respond('unproven')
        return
      }
      const proof = request.proof === 'stopped' && !owner.authorized ? 'unproven' : request.proof
      owner.proof = proof
      owner.settle(proof)
      void owner.completion.then(respond).finally(() => dispose(request.registrationId))
      return
    }
    const state = store.getState()
    const { target, ptyId } = owner
    if (owner.completion || !ptyId || !owner.ownership.eligible()) {
      respond('kept')
      return
    }
    let preservePane = request.preservePane
    owner.completion = (async () => {
      try {
        await state.shutdownCompletedAgentPaneForHibernation(target.worktreeId, {
          ...target,
          ptyId,
          lifecycle: {
            preservePane,
            stop: async (captured, transactionCurrent) => {
              owner.transactionCurrent = transactionCurrent
              preservePane = captured
              if (
                !preservePane &&
                isUnifiedTabPinned(store.getState(), target.worktreeId, target.tabId)
              ) {
                return 'live'
              }
              await persist()
              if (!owner.ownership.eligible() || owners.get(request.registrationId) !== owner) {
                return 'live'
              }
              const settlement = new Promise<'stopped' | 'live' | 'unproven'>((resolve) => {
                owner.settle = resolve
              })
              owner.prepared = true
              respond('prepared')
              return settlement
            }
          }
        })
        if (!preservePane) {
          if (!owner.ownership.eligible()) {
            return 'stopped-but-uncommitted'
          }
          let closed = false
          closeTerminalTab(target.tabId, {
            reason: 'cleanup',
            rejectPinned: true,
            skipRunningProcessConfirm: true,
            localPtyTeardownOwnedExternally: true,
            onClosed: () => {
              closed = true
            }
          })
          if (!closed) {
            return 'stopped-but-uncommitted'
          }
        }
        await persist()
        return preservePane ? 'hibernated' : 'closed'
      } catch {
        if (!owner.prepared) {
          respond('kept')
        }
        try {
          await persist()
        } catch {
          /* Preserve the captured record on an uncertain commit. */
        }
        return owner.proof === 'stopped'
          ? 'stopped-but-uncommitted'
          : owner.proof === 'live'
            ? 'kept-live'
            : owner.authorized
              ? 'unproven'
              : 'kept-live'
      }
    })()
  })
  return () => {
    release()
    for (const id of owners.keys()) {
      dispose(id)
    }
  }
}
