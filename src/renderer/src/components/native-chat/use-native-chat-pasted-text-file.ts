import {
  rememberTerminalPasteSource,
  retainTerminalPasteSources
} from './native-chat-terminal-paste-sources'
import { persistNativeChatComposerDraft } from './native-chat-composer-draft-persistence'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import {
  nativeChatPastedTextLabel,
  nativeChatPastedTextOperations,
  nativeChatPastedTextToken
} from './native-chat-pasted-text-reference'

import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { measureUtf8ByteLength } from '../../../../shared/utf8-byte-limits'
import { structuredAgentSessionBlocksTooLarge } from '../../../../shared/rpc-contract/structured-agent-session-message-params'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { imageReferencesToPromptMarkers } from '../../../../shared/native-chat-image-transcript-markers'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice,
  cachedNativeChatPasteUploadTarget,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'
import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { readNativeChatComposerDraft } from './native-chat-composer-draft-store'
import { nativeChatImageRowIds } from './native-chat-composer-image-references'
import {
  resolveNativeChatPastedText,
  settleNativeChatPastedText
} from './native-chat-composer-pasted-text-references'

export const NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD = 32 * 1024

function pastedTextTooLargeNotice(): string {
  return translate(
    'components.native-chat.composer.pastedTextTooLarge',
    'This paste would put your message over the 256 KB limit for one message. Shorten it, then paste again.'
  )
}

function nativeChatDraftTooLarge(scopeKey: string, text: string): boolean {
  const prompt = imageReferencesToPromptMarkers(
    resolveNativeChatPastedText(scopeKey, text),
    nativeChatImageRowIds(scopeKey)
  )
  const images = readNativeChatComposerDraft(scopeKey).images
  const body = structuredAgentSessionSendBody(
    prompt,
    images.map(({ path }) => ({ path, previewUri: '' }))
  )
  return structuredAgentSessionBlocksTooLarge(body.blocks)
}

export function useNativeChatPastedTextFile(args: {
  scopeKey: string
  /** The editor while it shows this scope; null without a draft scope. */
  scopeEditor: (() => NativeChatComposerInput | null) | null
  /** One structured message must fit 256 KB; a terminal-backed chat has no such limit. */
  structured: boolean
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  insertTypedText: (text: string) => boolean
  setNotice: (notice: string | null, errorText?: string) => void
}): (text: string) => boolean {
  const { scopeKey, scopeEditor, structured, resolveAttachmentOwner, insertTypedText, setNotice } =
    args
  return useCallback(
    (text: string): boolean => {
      const input = scopeEditor?.()
      if (!scopeEditor || !input?.stagePastedText || input.disabled) {
        return insertTypedText(text)
      }
      const { value, selectionStart, selectionEnd } = input
      const tooLarge =
        structured &&
        nativeChatDraftTooLarge(
          scopeKey,
          `${value.slice(0, selectionStart ?? 0)}${text}${value.slice(selectionEnd ?? 0)}`
        )
      const long =
        text.length >= NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD ||
        measureUtf8ByteLength(text, { stopAfterBytes: NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD - 1 })
          .exceededLimit
      const owner = resolveAttachmentOwner()
      const target =
        owner.kind === 'runtime-session' ? cachedNativeChatPasteUploadTarget(owner) : null
      const canAttach = owner.kind === 'local' || target !== null
      if (!tooLarge && (!long || !canAttach)) {
        return insertTypedText(text)
      }
      if (!canAttach) {
        setNotice(pastedTextTooLargeNotice())
        return true
      }
      input.focus()
      const id = createUuidV4()
      if (owner.kind === 'local' && !owner.structuredSessionId) {
        const source = { id, text }
        rememberTerminalPasteSource(source)
        input.stagePastedText(nativeChatPastedTextToken(id))
        retainTerminalPasteSources(scopeKey, input.value)
        persistNativeChatComposerDraft(scopeKey, 'immediate')
        return true
      }
      nativeChatPastedTextOperations.set(id, { scopeKey, text })
      input.stagePastedText(nativeChatPastedTextToken(id))
      const fail = (notice: string) => {
        if (settleNativeChatPastedText(id)) {
          setNotice(notice)
        }
      }
      void window.api.ui
        .savePastedTextAsFile({
          text,
          ...(target
            ? { runtimeEnvironmentId: target.environmentId, agentSessionAttachment: target }
            : {}),
          ...(owner.kind === 'local' && owner.structuredSessionId
            ? { forStructuredChat: true }
            : {})
        })
        .then(
          (path) => {
            if (nativeChatAttachmentOwnerUnchanged(owner, resolveAttachmentOwner())) {
              settleNativeChatPastedText(id, path)
            } else {
              fail(nativeChatAttachmentOwnerChangedNotice())
            }
          },
          (error) =>
            fail(
              nativeChatAttachFailedNotice(
                [nativeChatPastedTextLabel()],
                extractIpcErrorMessage(error, '')
              )
            )
        )
      return true
    },
    [insertTypedText, resolveAttachmentOwner, scopeEditor, scopeKey, setNotice, structured]
  )
}
