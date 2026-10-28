import { useCallback, useEffect, useRef, useState } from 'react'

export type ClipboardTextCopyStatus = 'idle' | 'copied' | 'failed'

const FEEDBACK_MS = 1500

type Feedback = {
  text: string
  status: Exclude<ClipboardTextCopyStatus, 'idle'>
}

type ClipboardCopyRequest = {
  applyFeedback: ((status: Feedback['status']) => void) | null
}

/** Show brief clipboard feedback, skipping late state writes after the menu/row unmounts. */
export function useClipboardTextCopyFeedback(text: string): {
  canCopy: boolean
  copyText: () => Promise<boolean>
  status: ClipboardTextCopyStatus
} {
  const { feedback, copyText: copyFeedbackText, clearResetTimer } = useClipboardCopyFeedback()
  const canCopy = text.trim().length > 0
  const status: ClipboardTextCopyStatus =
    feedback != null && feedback.text === text ? feedback.status : 'idle'

  useEffect(() => {
    clearResetTimer()
  }, [clearResetTimer, text])

  const copyText = useCallback((): Promise<boolean> => {
    return canCopy ? copyFeedbackText(text) : Promise.resolve(false)
  }, [canCopy, copyFeedbackText, text])

  return { canCopy, copyText, status }
}

export function useClipboardCopyFeedback({
  showFailure = true
}: {
  showFailure?: boolean
} = {}) {
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const isMountedRef = useRef(true)
  const resetTimerRef = useRef<number | null>(null)
  const pendingRequestsRef = useRef<Set<ClipboardCopyRequest> | null>(null)

  const clearResetTimer = useCallback((): void => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      clearResetTimer()
      const pendingRequests = pendingRequestsRef.current
      if (pendingRequests) {
        for (const request of pendingRequests) {
          request.applyFeedback = null
        }
        pendingRequests.clear()
        pendingRequestsRef.current = null
      }
    }
  }, [clearResetTimer])

  const scheduleReset = useCallback((): void => {
    clearResetTimer()
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null
      if (isMountedRef.current) {
        setFeedback(null)
      }
    }, FEEDBACK_MS)
  }, [clearResetTimer])

  const copyText = useCallback(
    (text: string): Promise<boolean> => {
      const request: ClipboardCopyRequest = {
        applyFeedback: (status) => {
          if (isMountedRef.current && (status === 'copied' || showFailure)) {
            setFeedback({ text, status })
            scheduleReset()
          }
        }
      }
      const pendingRequests = pendingRequestsRef.current ?? new Set<ClipboardCopyRequest>()
      pendingRequestsRef.current = pendingRequests
      pendingRequests.add(request)
      try {
        return finishClipboardCopy(window.api.ui.writeClipboardText(text), request, pendingRequests)
      } catch {
        return Promise.resolve(settleClipboardCopy(request, pendingRequests, 'failed'))
      }
    },
    [scheduleReset, showFailure]
  )

  return { feedback, copyText, clearResetTimer }
}

function finishClipboardCopy(
  write: Promise<void>,
  request: ClipboardCopyRequest,
  pendingRequests: Set<ClipboardCopyRequest>
): Promise<boolean> {
  return write.then(
    () => settleClipboardCopy(request, pendingRequests, 'copied'),
    () => settleClipboardCopy(request, pendingRequests, 'failed')
  )
}

function settleClipboardCopy(
  request: ClipboardCopyRequest,
  pendingRequests: Set<ClipboardCopyRequest>,
  status: Feedback['status']
): boolean {
  pendingRequests.delete(request)
  const applyFeedback = request.applyFeedback
  request.applyFeedback = null
  applyFeedback?.(status)
  return status === 'copied'
}
