import { useShellStorage } from '../platform/shell-storage'
import { useDirectionPadAvailable } from '../layout/use-shell-side-rail'
import { settleSessionPreferenceRead } from './session-preference-read'
import { useEffect, useRef, useCallback, useState } from 'react'
import { AppState, type AppStateStatus, Platform } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { loadHosts } from '../transport/host-store'
import { loadTerminalAccessoryLayout } from '../terminal/terminal-accessory-layout'
import {
  recoverActiveTerminalAfterForeground,
  shouldRecoverTerminalOnAppStateChange
} from '../terminal/terminal-foreground-recovery'
import { loadCustomKeys } from '../terminal/terminal-custom-keys'
import type { MobileSessionTabReconciliationModel } from './use-mobile-session-tab-reconciliation'

export function useMobileSessionLifecycle(scope: MobileSessionTabReconciliationModel) {
  const shellStorage = useShellStorage()
  const padAvailable = useDirectionPadAvailable()
  const [customKeysLoaded, setCustomKeysLoaded] = useState(false)
  const [accessoryLayoutLoaded, setAccessoryLayoutLoaded] = useState(false)
  const {
    hostId,
    connState,
    setCustomKeys,
    setVisibleBuiltInIds,
    setDirectionPadEnabled,
    setHostEndpoint,
    connStateRef,
    terminalRefs,
    initializedHandlesRef,
    activeHandleRef,
    visibleTerminalHandlesRef,
    scheduleDelayedAction,
    unsubscribeTerminal,
    subscribeToTerminal
  } = scope
  // Why: the shared client owns authenticated identity; this host read only supplies connection-hint metadata.
  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    void loadHosts().then((hosts) => {
      if (stale) {
        return
      }
      const host = hosts.find((h) => h.id === hostId)
      if (host) {
        setHostEndpoint(host.endpoint)
      }
    })
    return () => {
      stale = true
    }
  }, [hostId])

  const customReadRevisionRef = useRef(0)
  const refreshCustomKeys = useCallback(() => {
    const revision = ++customReadRevisionRef.current
    void settleSessionPreferenceRead(loadCustomKeys()).then((keys) => {
      if (customReadRevisionRef.current === revision) {
        if (keys) {
          setCustomKeys(keys)
        }
        setCustomKeysLoaded(true)
      }
    })
    return () => {
      if (customReadRevisionRef.current === revision) {
        customReadRevisionRef.current += 1
      }
    }
  }, [shellStorage])
  useFocusEffect(refreshCustomKeys)
  useEffect(
    () => () => {
      customReadRevisionRef.current += 1
    },
    []
  )

  const layoutReadRevisionRef = useRef(0)
  const refreshAccessoryLayout = useCallback(() => {
    const revision = ++layoutReadRevisionRef.current
    void settleSessionPreferenceRead(loadTerminalAccessoryLayout(padAvailable)).then((layout) => {
      if (layoutReadRevisionRef.current === revision) {
        if (layout) {
          setVisibleBuiltInIds(layout.visibleBuiltInIds)
          setDirectionPadEnabled(layout.directionPadEnabled !== false)
        }
        setAccessoryLayoutLoaded(true)
      }
    })
    return () => {
      if (layoutReadRevisionRef.current === revision) {
        layoutReadRevisionRef.current += 1
      }
    }
  }, [padAvailable, shellStorage])

  useFocusEffect(refreshAccessoryLayout)

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') {
        refreshAccessoryLayout()
        refreshCustomKeys()
      }
    })
    return () => {
      layoutReadRevisionRef.current += 1
      sub.remove()
    }
  }, [refreshAccessoryLayout, refreshCustomKeys])

  const pendingForegroundRecoveryRef = useRef(false)
  useEffect(() => {
    let previousAppState: AppStateStatus | null = AppState.currentState
    const sub = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      const shouldRecover = shouldRecoverTerminalOnAppStateChange(
        previousAppState,
        nextAppState,
        Platform.OS
      )
      previousAppState = nextAppState
      if (!shouldRecover) {
        return
      }
      for (const terminalRef of terminalRefs.current.values()) {
        terminalRef.prepareForForegroundRecovery()
      }
      // Why: iOS can resume a WKWebView with a blank xterm store and no web-ready; invalidate the latch so init waits for the pong.
      const outcome = recoverActiveTerminalAfterForeground({
        activeHandleRef,
        visibleTerminalHandlesRef,
        terminalRefs,
        initializedHandlesRef,
        connStateRef,
        unsubscribeTerminal,
        subscribeToTerminal,
        schedule: scheduleDelayedAction
      })
      pendingForegroundRecoveryRef.current = outcome === 'deferred'
    })
    return () => {
      sub.remove()
    }
  }, [scheduleDelayedAction, subscribeToTerminal, unsubscribeTerminal])

  // Why: resume lands mid-reconnect (socket dies in bg); re-run recovery once connected or a blanked WKWebView stays stale.
  useEffect(() => {
    if (connState !== 'connected' || !pendingForegroundRecoveryRef.current) {
      return
    }
    pendingForegroundRecoveryRef.current = false
    if (AppState.currentState !== 'active') {
      return
    }
    recoverActiveTerminalAfterForeground({
      activeHandleRef,
      visibleTerminalHandlesRef,
      terminalRefs,
      initializedHandlesRef,
      connStateRef,
      unsubscribeTerminal,
      subscribeToTerminal,
      schedule: scheduleDelayedAction
    })
  }, [connState, scheduleDelayedAction, subscribeToTerminal, unsubscribeTerminal])
  return {
    accessoryPreferencesReady: customKeysLoaded && accessoryLayoutLoaded,
    pendingForegroundRecoveryRef
  }
}

export type MobileSessionLifecycleModel = MobileSessionTabReconciliationModel &
  ReturnType<typeof useMobileSessionLifecycle>
