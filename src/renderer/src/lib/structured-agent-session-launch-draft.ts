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
import type { StructuredLaunchState } from './agent-session/launch/structured-agent-session-launch-registry'

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

/** Only this renderer's launch receipt authorizes removing its unchanged initializer. */
export function clearStructuredAgentLaunchDraft(receipt?: StructuredLaunchDraftReceipt): void {
  if (receipt && holdsInitializedDraft(receipt)) {
    updateNativeChatComposerDraft(receipt.scopeKey, { text: '', document: undefined }, 'immediate')
  }
}

export function structuredLaunchDraftHasUserContent(
  scopeKey: string,
  receipt?: StructuredLaunchDraftReceipt
): boolean {
  const draft = readNativeChatComposerDraft(scopeKey)
  const unpresented = receipt && !receipt.presented && holdsInitializedDraft(receipt)
  return (
    (!unpresented && draft.text.trim() !== '') ||
    draft.images.length > 0 ||
    nativeChatPendingAttachmentSnapshot(scopeKey).length > 0
  )
}
