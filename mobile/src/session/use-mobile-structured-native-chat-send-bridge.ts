import { useCallback } from 'react'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import type { StructuredAgentId } from '../../../src/shared/agent-session-provider-handle'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from './native-chat/mobile-native-chat-pending-echo'
import type { StructuredMobileSendAttachment } from './use-mobile-structured-send-with-outcome'

export function useMobileStructuredNativeChatSendBridge(args: {
  agent: StructuredAgentId | undefined
  sessionCommands?: readonly AgentSessionSlashCommand[]
  sendStructured: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileSendAttachment[]
  ) => Promise<MobileNativeChatSendOutcome>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
  onSendError: (message: string) => void
}): {
  send: (text: string, images?: string[]) => Promise<boolean>
  sendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileSendAttachment[]
  ) => Promise<MobileNativeChatSendOutcome>
} {
  const {
    agent,
    captureSendOrigin,
    clearDraftForSend,
    onSendError,
    restoreRejectedDraft,
    sendStructured,
    sessionCommands
  } = args
  const sendWithOutcome = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[]
    ): Promise<MobileNativeChatSendOutcome> => {
      const origin = captureSendOrigin(text.trimEnd())
      if (!origin) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      clearDraftForSend(origin, text)
      const outcome =
        attachments !== undefined
          ? await sendStructured(text, images, deadline, attachments)
          : deadline !== undefined
            ? await sendStructured(text, images, deadline)
            : images !== undefined
              ? await sendStructured(text, images)
              : await sendStructured(text)
      // A lost result returns the person's text immediately, even if a later receipt lands.
      if (outcome === 'rejected' || outcome === 'unknown') {
        restoreRejectedDraft(origin, text)
        if (outcome === 'unknown') {
          onSendError(
            "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."
          )
        }
      }
      return outcome
    },
    [
      agent,
      captureSendOrigin,
      clearDraftForSend,
      onSendError,
      restoreRejectedDraft,
      sendStructured,
      sessionCommands
    ]
  )
  const send = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[]
    ) => (await sendWithOutcome(text, images, deadline, attachments)) !== 'rejected',
    [sendWithOutcome]
  )
  return { send, sendWithOutcome }
}
