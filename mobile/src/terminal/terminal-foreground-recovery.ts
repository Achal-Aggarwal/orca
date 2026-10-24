import type { RefObject } from 'react'
import type { ConnectionState } from '../transport/types'
import type { TerminalWebViewHandle } from './TerminalWebView'

export const TERMINAL_FOREGROUND_RECOVERY_DELAY_MS = 120

// 'deferred' = the socket wasn't connected at the foreground edge (it usually
// dies after ~60-80s of background); the caller must re-run recovery once the
// connection is back or a blanked WKWebView stays stale until a tab switch.
export type TerminalForegroundRecoveryOutcome = 'recovered' | 'deferred' | 'skipped'

type TerminalForegroundRecoveryOptions = {
  activeHandleRef: RefObject<string | null>
  visibleTerminalHandlesRef?: RefObject<readonly string[]>
  terminalRefs: RefObject<Map<string, TerminalWebViewHandle>>
  initializedHandlesRef: RefObject<Set<string>>
  connStateRef: RefObject<ConnectionState>
  unsubscribeTerminal: (handle: string) => void
  subscribeToTerminal: (handle: string) => void
  schedule: (fn: () => void, ms: number) => void
  delayMs?: number
}

export function shouldRecoverTerminalOnAppStateChange(
  previousState: string | null | undefined,
  nextState: string,
  platform: string
): boolean {
  return (
    platform === 'ios' &&
    nextState === 'active' &&
    (previousState === 'background' || previousState === 'inactive')
  )
}

export function recoverActiveTerminalAfterForeground({
  activeHandleRef,
  visibleTerminalHandlesRef,
  terminalRefs,
  initializedHandlesRef,
  connStateRef,
  unsubscribeTerminal,
  subscribeToTerminal,
  schedule,
  delayMs = TERMINAL_FOREGROUND_RECOVERY_DELAY_MS
}: TerminalForegroundRecoveryOptions): TerminalForegroundRecoveryOutcome {
  if (connStateRef.current !== 'connected') {
    return 'deferred'
  }
  const initializedMountedHandles = Array.from(initializedHandlesRef.current).filter((handle) =>
    terminalRefs.current.has(handle)
  )
  if (initializedMountedHandles.length === 0) {
    return 'skipped'
  }
  const visible =
    visibleTerminalHandlesRef?.current ?? (activeHandleRef.current ? [activeHandleRef.current] : [])
  const recovering = visible.filter((handle) => initializedMountedHandles.includes(handle))

  // Why: inactive terminal WebViews stay mounted with opacity:0; iOS can blank
  // those backing stores too, so their next activation must accept scrollback.
  for (const initializedHandle of initializedMountedHandles) {
    initializedHandlesRef.current.delete(initializedHandle)
  }

  for (const handle of recovering) {
    unsubscribeTerminal(handle)
    schedule(() => {
      if (connStateRef.current !== 'connected') {
        return
      }
      const stillVisible = visibleTerminalHandlesRef
        ? visibleTerminalHandlesRef.current.includes(handle)
        : activeHandleRef.current === handle
      if (stillVisible && terminalRefs.current.has(handle)) {
        subscribeToTerminal(handle)
      }
    }, delayMs)
  }
  return 'recovered'
}
