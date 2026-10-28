import { useEffect } from 'react'
import { getStructuredLaunchStateBySessionId } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'

export function markStructuredLaunchDraftPresented(sessionId: string): void {
  const receipt = getStructuredLaunchStateBySessionId(sessionId)?.draftReceipt
  if (receipt) {
    receipt.presented = true
  }
}

export function useStructuredLaunchDraftPresentation(
  sessionId: string | undefined,
  draft: string
): void {
  useEffect(() => {
    if (sessionId && draft !== '') {
      markStructuredLaunchDraftPresented(sessionId)
    }
  }, [sessionId, draft])
}
