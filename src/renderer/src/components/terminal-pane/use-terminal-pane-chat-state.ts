import { useTerminalPaneChatEligibility } from './use-terminal-pane-chat-eligibility'
import { decideTerminalForegroundPresentation } from '../../../../shared/terminal-foreground-presentation'
import {
  desktopPresentationForExit,
  desktopPresentationSnapshot,
  subscribeDesktopPresentation
} from '@/runtime/terminal-foreground-presentation'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { useTerminalPaneStoreActions } from './use-terminal-pane-store-actions'
import { selectUnifiedTerminalTabFields } from './terminal-unified-tab-lookup'
import {
  resolveNativeChatLeafRoute,
  type NativeChatLeafRoute
} from '../native-chat/native-chat-leaf-routing'
import type { TerminalPaneTitleController } from './use-terminal-pane-title-state'

export function useTerminalPaneChatState(controller: TerminalPaneTitleController) {
  const { chatLeafId, managerRef, onAgentExitedRef, setChatLeafId, tabId, worktreeId } = controller
  const {
    clearCodexRestartNotice,
    consumePendingPaneAccountRestart,
    setTabCanExpandPane,
    setTabLayout,
    setTabPaneExpanded,
    setTabViewMode,
    suppressPtyExit,
    toggleTabViewMode
  } = useTerminalPaneStoreActions()
  // Bundle unified-tab reads to reduce lookups and subscriptions per mounted tab.
  const { unifiedTabId, isChatViewMode, unifiedTabLabel, isTabPinned } = useAppStore(
    useShallow((store) =>
      selectUnifiedTerminalTabFields(store.unifiedTabsByWorktree, worktreeId, tabId)
    )
  )
  const {
    runtimePaneTitlesByPaneId,
    tabAgentTypeByLeaf,
    savedLayout,
    terminalTab,
    restoredLayout,
    expectedLayoutLeafIds,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    getTabWideAgentHintLeafIdRef,
    resolveTitleAgentForLeaf,
    isChatEligibleForLeaf
  } = useTerminalPaneChatEligibility(controller, unifiedTabLabel)
  const applyNativeChatLeafRoute = useCallback(
    (route: NativeChatLeafRoute): void => {
      const state = useAppStore.getState()
      const currentMode = selectUnifiedTerminalTabFields(
        state.unifiedTabsByWorktree,
        worktreeId,
        tabId
      ).isChatViewMode
      if (!isChatViewMode && currentMode && chatLeafId && route.chatLeafId === null) {
        // Keep the owner through the batched toggle that turns chat mode on.
        return
      }
      if (route.chatLeafId !== chatLeafId) {
        setChatLeafId(route.chatLeafId)
      }
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId]
      if (existingLayout && existingLayout.chatLeafId !== (route.chatLeafId ?? undefined)) {
        if (route.chatLeafId) {
          setTabLayout(tabId, { ...existingLayout, chatLeafId: route.chatLeafId })
        } else if (existingLayout?.chatLeafId) {
          const nextLayout = { ...existingLayout }
          delete nextLayout.chatLeafId
          setTabLayout(tabId, nextLayout)
        }
      }
      if (route.exitChat && unifiedTabId) {
        setTabViewMode(unifiedTabId, 'terminal')
      }
    },
    [
      chatLeafId,
      isChatViewMode,
      setTabLayout,
      setTabViewMode,
      tabId,
      unifiedTabId,
      worktreeId,
      setChatLeafId
    ]
  )
  const selectedPtyId = chatLeafId ? savedLayout.ptyIdsByLeafId?.[chatLeafId] : null
  const subscribe = useCallback(
    (listener: () => void) =>
      selectedPtyId ? subscribeDesktopPresentation(selectedPtyId, listener) : () => {},
    [selectedPtyId]
  )
  const snapshot = useCallback(() => desktopPresentationSnapshot(selectedPtyId), [selectedPtyId])
  const presentation = useSyncExternalStore(subscribe, snapshot, snapshot)
  const [, redrawRoute] = useState(0)
  const routeAction = useRef<{
    fact: typeof presentation
    leaf: string | null
    refused: boolean
    pending: boolean
  } | null>(null)
  useLayoutEffect(() => {
    if (!isChatViewMode || routeAction.current?.leaf !== chatLeafId) {
      routeAction.current = null
    }
  }, [isChatViewMode, chatLeafId])
  const release =
    decideTerminalForegroundPresentation({
      accepted: presentation?.state,
      currentBinding: Boolean(selectedPtyId),
      member: Boolean(chatLeafId),
      wantsChat: isChatViewMode
    }) === 'release'
  const activeLeaf = managerRef.current?.getActivePane()?.leafId ?? null
  const effectiveRoute =
    release && !(routeAction.current?.fact === presentation && routeAction.current?.refused)
      ? resolveNativeChatLeafRoute({
          isChatViewMode,
          chatLeafId,
          activeLeafId: activeLeaf,
          chatLeafStillMounted: true,
          activeLeafIsEligible: isChatEligibleForLeaf(activeLeaf),
          chatLeafHasConfirmedAgentExit: true
        })
      : null
  const effectiveChatViewMode = isChatViewMode && !effectiveRoute?.exitChat
  const effectiveChatLeafId = effectiveRoute ? effectiveRoute.chatLeafId : chatLeafId
  useLayoutEffect(() => {
    if (!effectiveRoute || !unifiedTabId) {
      return
    }
    if (!effectiveRoute.exitChat) {
      applyNativeChatLeafRoute(effectiveRoute)
      return
    }
    if (
      routeAction.current?.leaf === chatLeafId &&
      (routeAction.current.pending || routeAction.current.fact === presentation)
    ) {
      if (routeAction.current.pending) {
        routeAction.current.fact = presentation
      }
      return
    }
    const action = { fact: presentation, leaf: chatLeafId, refused: false, pending: true }
    routeAction.current = action
    const layout = useAppStore.getState().terminalLayoutsByTabId[tabId]
    if (layout?.chatLeafId) {
      const next = { ...layout }
      delete next.chatLeafId
      setTabLayout(tabId, next)
    }
    setTabViewMode(unifiedTabId, 'terminal', (accepted) => {
      if (routeAction.current !== action) {
        return
      }
      action.pending = false
      action.refused = !accepted
      if (accepted) {
        setChatLeafId(null)
      }
      redrawRoute((value) => value + 1)
    })
  }, [
    effectiveRoute,
    presentation,
    chatLeafId,
    unifiedTabId,
    tabId,
    setTabLayout,
    setTabViewMode,
    setChatLeafId,
    applyNativeChatLeafRoute
  ])
  const handleConfirmedAgentExit = useCallback(
    (leafId: string): void => {
      const id = useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
      if (
        decideTerminalForegroundPresentation({
          accepted: id ? desktopPresentationForExit(id) : 'gone',
          currentBinding: true,
          member: leafId === chatLeafId,
          wantsChat: isChatViewMode
        }) !== 'release'
      ) {
        return
      }
      if (desktopPresentationSnapshot(id)?.support === 'supported') {
        return
      }

      if (leafId !== chatLeafId) {
        return
      }
      const panes = managerRef.current?.getPanes() ?? []
      const activeLeafId = managerRef.current?.getActivePane()?.leafId ?? null
      applyNativeChatLeafRoute(
        resolveNativeChatLeafRoute({
          isChatViewMode,
          chatLeafId,
          activeLeafId,
          chatLeafStillMounted: panes.some((pane) => pane.leafId === chatLeafId),
          activeLeafIsEligible: isChatEligibleForLeaf(activeLeafId),
          chatLeafHasConfirmedAgentExit: true
        })
      )
    },
    [applyNativeChatLeafRoute, chatLeafId, isChatEligibleForLeaf, isChatViewMode, managerRef, tabId]
  )
  useEffect(() => {
    onAgentExitedRef.current = handleConfirmedAgentExit
  }, [handleConfirmedAgentExit, onAgentExitedRef])
  const canToggleChatForLeaf = useCallback(
    (leafId: string | null): boolean => {
      // Scope the "always allow toggling back" rule to the leaf showing chat; must not make an unsupported sibling look eligible.
      const isChatViewForLeaf = effectiveChatViewMode && leafId !== null && chatLeafId === leafId
      return isChatViewForLeaf || isChatEligibleForLeaf(leafId)
    },
    [chatLeafId, effectiveChatViewMode, isChatEligibleForLeaf]
  )
  const toggleNativeChatForLeaf = useCallback(
    (leafId: string) => {
      routeAction.current = null
      if (!unifiedTabId) {
        return
      }
      if (effectiveChatViewMode && chatLeafId === leafId) {
        setChatLeafId(null)
        toggleTabViewMode(unifiedTabId)
        return
      }
      setChatLeafId(leafId)
      if (!effectiveChatViewMode) {
        toggleTabViewMode(unifiedTabId)
      }
    },
    [chatLeafId, effectiveChatViewMode, setChatLeafId, toggleTabViewMode, unifiedTabId]
  )
  const handleToggleNativeChat = useCallback(() => {
    const activeLeafId = managerRef.current?.getActivePane()?.leafId ?? null
    if (!activeLeafId) {
      return
    }
    toggleNativeChatForLeaf(activeLeafId)
  }, [toggleNativeChatForLeaf, managerRef])
  const switchNativeChatToTerminal = useCallback(() => {
    if (chatLeafId && unifiedTabId) {
      setChatLeafId(null)
      setTabViewMode(unifiedTabId, 'terminal')
    }
  }, [chatLeafId, setChatLeafId, setTabViewMode, unifiedTabId])
  const readNativeChatTerminalScreen = useCallback((): string | null => {
    if (!chatLeafId) {
      return null
    }
    const pane = managerRef.current?.getPanes().find((candidate) => candidate.leafId === chatLeafId)
    return pane?.serializeAddon.serialize({ scrollback: 0 }) ?? null
  }, [chatLeafId, managerRef])

  return {
    chatLeafId: effectiveChatLeafId,
    setTabPaneExpanded,
    setTabCanExpandPane,
    suppressPtyExit,
    consumePendingPaneAccountRestart,
    clearCodexRestartNotice,
    unifiedTabId,
    isChatViewMode,
    effectiveChatViewMode,
    unifiedTabLabel,
    isTabPinned,
    runtimePaneTitlesByPaneId,
    tabAgentTypeByLeaf,
    setTabViewMode,
    savedLayout,
    terminalTab,
    restoredLayout,
    expectedLayoutLeafIds,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    getTabWideAgentHintLeafIdRef,
    resolveTitleAgentForLeaf,
    isChatEligibleForLeaf,
    canToggleChatForLeaf,
    toggleNativeChatForLeaf,
    handleToggleNativeChat,
    applyNativeChatLeafRoute,
    switchNativeChatToTerminal,
    readNativeChatTerminalScreen
  }
}

export type TerminalPaneChatController = TerminalPaneTitleController &
  ReturnType<typeof useTerminalPaneChatState>
