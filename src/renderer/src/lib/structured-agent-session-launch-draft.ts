import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import { sameNativeChatComposerDraftDocument } from '@/components/native-chat/native-chat-composer-draft-comparison'
import { promptTextContent } from '@/components/native-chat/native-chat-prompt-document-text'
import { nativeChatPendingAttachmentSnapshot } from '@/components/native-chat/native-chat-pending-attachment-cache'
import type { NativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-storage'
import type { StructuredAgentLaunchOptions } from './structured-agent-session-launch-callers'
import {
  getStructuredLaunchStateBySessionId,
  type StructuredLaunchState
} from './agent-session/launch/structured-agent-session-launch-registry'

export type StructuredLaunchDraftReceipt = Pick<NativeChatComposerDraft, 'text' | 'document'> & {
  scopeKey: string
  presented: boolean
}

export function seedStructuredAgentLaunchDraft(
  state: StructuredLaunchState,
  options: StructuredAgentLaunchOptions
): void {
  if (options.promptDelivery !== 'draft' || !options.prompt) {
    return
  }
  const { sessionId, worktreeId, executionHostId } = state.intent
  const scopeKey = structuredAgentSessionDraftScopeKey(sessionId)
  const current = readNativeChatComposerDraft(scopeKey)
  if (current.text !== '' || current.document) {
    return
  }
  const document = promptTextContent(options.prompt)
  state.draftReceipt = { scopeKey, text: options.prompt, document, presented: false }
  updateNativeChatComposerDraft(
    scopeKey,
    { text: options.prompt, document, owner: { workspaceId: worktreeId, executionHostId } },
    'immediate'
  )
}

function holdsInitializedDraft(receipt: StructuredLaunchDraftReceipt): boolean {
  const current = readNativeChatComposerDraft(receipt.scopeKey)
  return (
    current.text === receipt.text &&
    sameNativeChatComposerDraftDocument(current.document, receipt.document)
  )
}

/** Capture current provisional authority; cancellation consumes it synchronously before yielding. */
export function readStructuredLaunchDraft(
  state: StructuredLaunchState | undefined,
  owner: Pick<StructuredLaunchState['intent'], 'worktreeId' | 'sessionId' | 'executionHostId'>
) {
  const scopeKey = structuredAgentSessionDraftScopeKey(owner.sessionId)
  const receipt =
    state &&
    getStructuredLaunchStateBySessionId(owner.sessionId) === state &&
    state.intent.worktreeId === owner.worktreeId &&
    state.intent.executionHostId === owner.executionHostId &&
    !state.cancelled &&
    !state.hostListed &&
    state.callers.outcome !== 'published' &&
    state.draftReceipt?.scopeKey === scopeKey
      ? state.draftReceipt
      : undefined
  const draft = readNativeChatComposerDraft(scopeKey)
  const unpresented = receipt && !receipt.presented && holdsInitializedDraft(receipt)
  return {
    hasUserContent:
      (!unpresented && draft.text.trim() !== '') ||
      draft.images.length > 0 ||
      nativeChatPendingAttachmentSnapshot(scopeKey).length > 0,
    clear: () => {
      if (receipt && holdsInitializedDraft(receipt)) {
        updateNativeChatComposerDraft(scopeKey, { text: '', document: undefined }, 'immediate')
      }
    }
  }
}
