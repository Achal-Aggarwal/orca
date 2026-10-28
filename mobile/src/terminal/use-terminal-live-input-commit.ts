import { useCallback, useEffect, useRef } from 'react'
import { reportedLiveInputComposing } from '../platform/live-input-composing-range'
import {
  getTerminalLiveSpecialKeyDecision,
  type TerminalLiveInputSelection
} from './terminal-live-text-commit'
import { writeTerminalLiveInputText } from './terminal-live-input-text-write'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'
import { useTerminalLivePendingInputFlush } from './use-terminal-live-pending-input-flush'
import { useTerminalLiveAccessoryInputCommit } from './use-terminal-live-accessory-input-commit'
import type {
  TerminalLiveInputChangeEvent,
  TerminalLiveInputCommitHandlers,
  TerminalLiveInputCommitOptions,
  TerminalLiveInputKeyPressEvent,
  TerminalLiveInputSelectionChangeEvent
} from './terminal-live-input-commit-contract'

// Native text changes queued before a reset can arrive after it.
const ENDED_SESSION_ECHO_MS = 500

export function useTerminalLiveInputCommit<TTabType extends string>({
  activeHandle,
  activeHandleRef,
  activeSessionTabType,
  activeSessionTabTypeRef,
  connected,
  liveInputRef,
  liveInputTerminalHandles,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLiveInputCommitOptions<TTabType>): TerminalLiveInputCommitHandlers {
  const interactionGenerationRef = useRef(0)
  // Click guards compare against the field text cleared before the cursor moved.
  const liveInputTextRef = useRef('')
  const endedSessionTextRef = useRef<{
    readonly handle: string
    readonly text: string
    readonly at: number
  } | null>(null)
  const liveInputSelectionRef = useRef<TerminalLiveInputSelection | null>(null)
  const liveInputSelectionSnapshotRef = useRef<{
    readonly text: string
    readonly selection: TerminalLiveInputSelection
  } | null>(null)
  const updateLiveInputCapture = useCallback(
    (text: string) => {
      liveInputTextRef.current = text
      if (text.length === 0) {
        liveInputSelectionRef.current = null
        liveInputSelectionSnapshotRef.current = null
      }
      setLiveInputCapture(text)
    },
    [setLiveInputCapture]
  )
  const advanceLiveInputInteractionGeneration = useCallback(() => {
    interactionGenerationRef.current += 1
  }, [])
  const {
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    endLiveInputSessionThenSend,
    flushPendingLiveInputText,
    heldLiveInputTextRef,
    liveInputComposingRef,
    pendingLiveInputHandleRef,
    queueLiveInputControl,
    sentLiveInputTextRef,
    waitForPendingLiveInputFlush
  } = useTerminalLivePendingInputFlush({
    activeHandleRef,
    activeSessionTabTypeRef,
    liveInputRef,
    liveInputTerminalHandlesRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture: updateLiveInputCapture
  })

  useEffect(() => {
    // Outages make delivered echo unknown; reset mirror state or the next send may corrupt PTY text.
    if (!connected) {
      clearPendingLiveInputCommit()
    }
  }, [connected, clearPendingLiveInputCommit])

  useEffect(() => {
    const pendingHandle = pendingLiveInputHandleRef.current
    if (!pendingHandle) {
      return
    }
    // Null tab type during list lag is unknown; only a known switch retires input, while flush guards still reject stale targets.
    if (
      !activeHandle ||
      pendingHandle !== activeHandle ||
      (activeSessionTabType != null && activeSessionTabType !== 'terminal') ||
      !liveInputTerminalHandles.has(activeHandle)
    ) {
      clearPendingLiveInputCommit()
    }
  }, [activeHandle, activeSessionTabType, clearPendingLiveInputCommit, liveInputTerminalHandles])

  const flushPendingLiveInputBeforeExternalSend = useCallback(
    async (handle: string): Promise<boolean> => {
      advanceLiveInputInteractionGeneration()
      const pendingHandle = pendingLiveInputHandleRef.current
      if (pendingHandle && pendingHandle !== handle) {
        clearPendingLiveInputCommit()
        return waitForPendingLiveInputFlush()
      }
      // External bytes follow field echo; end the field session so later diffs cannot erase dictation/paste.
      if (pendingHandle === handle) {
        return flushPendingLiveInputText(handle)
      }
      return waitForPendingLiveInputFlush()
    },
    [
      advanceLiveInputInteractionGeneration,
      clearPendingLiveInputCommit,
      flushPendingLiveInputText,
      waitForPendingLiveInputFlush
    ]
  )

  // Clicks, Return and held-text controls leave the mirror’s assumed field; start a new editing session.
  const endFieldSessionThenSend = useCallback(
    (handle: string, bytes: string): Promise<boolean> => {
      advanceLiveInputInteractionGeneration()
      const fieldText = liveInputTextRef.current
      endedSessionTextRef.current =
        fieldText.length > 0 ? { handle, text: fieldText, at: Date.now() } : null
      return endLiveInputSessionThenSend(handle, bytes)
    },
    [advanceLiveInputInteractionGeneration, endLiveInputSessionThenSend]
  )

  const getEndedSession = useCallback(() => {
    const endedSession = endedSessionTextRef.current
    if (
      !endedSession ||
      endedSession.handle !== activeHandleRef.current ||
      Date.now() - endedSession.at > ENDED_SESSION_ECHO_MS
    ) {
      endedSessionTextRef.current = null
      return null
    }
    return endedSession
  }, [activeHandleRef])

  // Ignore the cleared field’s native echo or it would retype old text at the new cursor.
  const dropEndedSessionEcho = useCallback(
    (text: string): boolean => {
      const endedSession = getEndedSession()
      if (!endedSession) {
        return false
      }
      if (text === endedSession.text) {
        liveInputSelectionRef.current = null
        liveInputSelectionSnapshotRef.current = null
        writeTerminalLiveInputText(liveInputRef, '')
        return true
      }
      // Ignore the clear’s empty echo until actual new input arrives.
      if (text.length > 0) {
        endedSessionTextRef.current = null
      }
      return false
    },
    [getEndedSession, liveInputRef]
  )

  const handleLiveInputChange = useCallback(
    ({ nativeEvent }: TerminalLiveInputChangeEvent) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        clearPendingLiveInputCommit()
        return
      }
      // Echo native field text verbatim so iOS keeps dictation/IME alive; normalize only the PTY mirror.
      advanceLiveInputInteractionGeneration()
      // DOM input signals fresh edits even when mobile keyboards omit key events.
      if (nativeEvent.inputType) {
        endedSessionTextRef.current = null
      } else if (dropEndedSessionEcho(nativeEvent.text)) {
        return
      }
      const snapshot = liveInputSelectionSnapshotRef.current
      liveInputSelectionRef.current =
        snapshot?.text === nativeEvent.text ? snapshot.selection : null
      updateLiveInputCapture(nativeEvent.text)
      void applyLiveInputMirror(
        activeHandle,
        normalizeTerminalTextInput(nativeEvent.text),
        reportedLiveInputComposing(nativeEvent.isComposing)
      )
    },
    [
      activeHandle,
      advanceLiveInputInteractionGeneration,
      applyLiveInputMirror,
      clearPendingLiveInputCommit,
      dropEndedSessionEcho,
      liveInputTerminalHandles,
      updateLiveInputCapture
    ]
  )

  const getLiveInputInteractionGeneration = useCallback(() => interactionGenerationRef.current, [])

  const handleLiveInputSelectionChange = useCallback(
    ({ nativeEvent }: TerminalLiveInputSelectionChangeEvent) => {
      const endedSession = getEndedSession()
      if (endedSession && nativeEvent.text === endedSession.text) {
        return
      }
      // Only accessory deletion reads this; native caret movement never sends PTY controls.
      const snapshot = {
        text: nativeEvent.text ?? liveInputTextRef.current,
        selection: nativeEvent.selection
      }
      liveInputSelectionSnapshotRef.current = snapshot
      liveInputSelectionRef.current =
        snapshot.text === liveInputTextRef.current ? snapshot.selection : null
    },
    [getEndedSession]
  )

  const handleLiveInputKeyPress = useCallback(
    (event: TerminalLiveInputKeyPressEvent) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      advanceLiveInputInteractionGeneration()
      if (endedSessionTextRef.current) {
        liveInputSelectionRef.current = null
        liveInputSelectionSnapshotRef.current = null
        endedSessionTextRef.current = null
      }
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      if (pendingLiveInputHandleRef.current && !ownsPendingState) {
        clearPendingLiveInputCommit()
      }
      const decision = getTerminalLiveSpecialKeyDecision({
        key: event.nativeEvent.key,
        heldText: ownsPendingState ? heldLiveInputTextRef.current : '',
        sentText: ownsPendingState ? sentLiveInputTextRef.current : ''
      })
      switch (decision.kind) {
        case 'ignore':
        case 'local-edit':
          return
        case 'send-now':
          void queueLiveInputControl(activeHandle, decision.bytes)
          return
        case 'commit-held-then-send':
          void endFieldSessionThenSend(activeHandle, decision.bytes)
          return
        default:
          decision satisfies never
      }
    },
    [
      activeHandle,
      advanceLiveInputInteractionGeneration,
      clearPendingLiveInputCommit,
      endFieldSessionThenSend,
      liveInputTerminalHandles,
      queueLiveInputControl
    ]
  )

  const handleLiveInputAccessoryBytes = useTerminalLiveAccessoryInputCommit({
    activeHandle,
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    endLiveInputSessionThenSend: endFieldSessionThenSend,
    heldLiveInputTextRef,
    liveInputComposingRef,
    liveInputRef,
    liveInputTextRef,
    liveInputSelectionRef,
    liveInputTerminalHandles,
    onInteraction: advanceLiveInputInteractionGeneration,
    pendingLiveInputHandleRef,
    queueLiveInputControl,
    sentLiveInputTextRef,
    setLiveInputCapture: updateLiveInputCapture,
    waitForPendingLiveInputFlush
  })

  const handleLiveInputSubmit = useCallback((): Promise<boolean> => {
    if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
      return Promise.resolve(false)
    }
    return endFieldSessionThenSend(activeHandle, '\r')
  }, [activeHandle, endFieldSessionThenSend, liveInputTerminalHandles])

  return {
    clearPendingLiveInputCommit,
    flushPendingLiveInputBeforeExternalSend,
    getLiveInputInteractionGeneration,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSelectionChange,
    handleLiveInputSubmit,
    sendLiveInputClick: endFieldSessionThenSend
  }
}
