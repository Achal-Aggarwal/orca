import { registerNativeChatPtySendPreparation } from './native-chat-pty-send-queue'
import { sameNativeChatComposerDraftImages } from './native-chat-composer-draft-comparison'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice
} from './native-chat-attachment-upload'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { readNativeChatComposerDraft } from './native-chat-composer-draft-store'
import {
  NATIVE_CHAT_PASTED_TEXT_TOKEN,
  nativeChatPastedTextId,
  nativeChatPastedTextLabel
} from './native-chat-pasted-text-reference'
import { readTerminalPasteSource } from './native-chat-terminal-paste-sources'
import {
  admitNativeChatPastedText,
  resolveNativeChatPastedText
} from './native-chat-composer-pasted-text-references'
import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import { useAppStore } from '../../store'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  submitNativeChatPrompt
} from './native-chat-runtime-send'
import type { NativeChatSendHandle } from './native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'
import { resolveNativeChatLaunchDraftSend } from './native-chat-launch-draft-send'
import { nativeChatComposerTargetIsRemote } from './native-chat-composer-target'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { isSlashCommandDraft } from '../../../../shared/native-chat/input/native-chat-slash-commands'
import type { NativeChatPickerState } from './use-native-chat-picker-state'
import type { NativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import type { NativeChatPtySessionOptionsSurface } from '../../../../shared/native-chat-pty-session-options'
import type { NativeChatOptimisticSendOutcome } from './native-chat-composer-types'
import {
  answerNativeChatCommandInComposer,
  type NativeChatLocalCommandAnswer
} from './use-native-chat-local-command-answer'

export function useNativeChatPtyComposerSend(args: {
  agent: AgentType
  draft: string
  draftScopeKey: string
  imageAttachments: readonly { path: string }[]
  disabled: boolean
  isDispatchingSessionOption: boolean
  launchDraft?: NativeChatLaunchDraft | null
  launchDraftResolved: boolean
  readTerminalScreen?: () => string | null
  resolveTarget: () => NativeChatResolvedTarget | null
  classifySend: NativeChatPickerState['classifySend']
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  optimisticSendOutcome?: NativeChatOptimisticSendOutcome
  onSlashCommand?: (command: string, output?: string) => void
  answerCommandLocally?: NativeChatLocalCommandAnswer
  onSubmitted?: () => void
  sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  terminalTabId: string
  trackPendingSend: NativeChatSendLifecycle['trackPendingSend']
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  clearSkillOrigin: () => void
  clearImageAttachments: () => void
  setNotice: (notice: string | null) => void
}): () => void {
  const preparing = useRef<NativeChatSendHandle | null>(null)
  const latest = useRef(args)
  latest.current = args
  return useCallback(() => {
    const submitted = args.draft
    const text = submitted
    const originalDraft = readNativeChatComposerDraft(args.draftScopeKey)
    const imagePaths = args.imageAttachments.map((attachment) => attachment.path)
    if (preparing.current) {
      return
    }
    if ((text.trim() === '' && imagePaths.length === 0) || args.disabled) {
      return
    }
    // Prevent option commands from interleaving with prompt writes on the PTY input line.
    if (args.isDispatchingSessionOption) {
      return
    }
    const target = args.resolveTarget()
    if (!target) {
      return
    }
    const classification = args.classifySend(text)
    if (classification === 'command' && answerNativeChatCommandInComposer(args)) {
      return
    }
    if (!admitNativeChatPastedText(args.draftScopeKey, text, args.setNotice)) {
      return
    }
    const dispatch = (text: string) => {
      const { sendOptions: launchSendOptions } = resolveNativeChatLaunchDraftSend({
        launchDraft: args.launchDraft,
        launchDraftResolved: args.launchDraftResolved,
        agent: args.agent,
        readScreen: () => args.readTerminalScreen?.()
      })
      let pendingId: string | undefined
      const sendOptions =
        args.agent === 'claude' && classification === 'chat'
          ? {
              ...launchSendOptions,
              onWriteRejected: () => {
                if (pendingId) {
                  args.optimisticSendOutcome?.reject(pendingId)
                }
              },
              onWriteUnconfirmed: () => {
                if (pendingId) {
                  args.optimisticSendOutcome?.holdUnconfirmed(pendingId)
                }
              }
            }
          : launchSendOptions
      let pendingHandle: NativeChatSendHandle | null = null
      // Slash-like drafts with images must retain their attachments.
      if (classification !== 'chat' && imagePaths.length === 0) {
        pendingHandle =
          args.agent === 'codex' && isSlashCommandDraft(text)
            ? sendNativeChatTypedCommand(target.ptyId, text)
            : sendNativeChatMessage(target.ptyId, text, sendOptions)
      } else if (imagePaths.length > 0) {
        pendingHandle = sendNativeChatMessageWithImageAttachments(
          args.agent,
          target.ptyId,
          text,
          imagePaths,
          sendOptions
        )
      } else if (text.trim().length > 0) {
        pendingHandle = sendNativeChatMessage(target.ptyId, text, sendOptions)
      } else {
        submitNativeChatPrompt(target.ptyId)
      }
      if (classification !== 'chat') {
        if (pendingHandle) {
          args.trackPendingSend(pendingHandle)
        }
        if (classification === 'command') {
          args.onSlashCommand?.(text.trim())
          args.sessionOptionsSurface?.recordOutgoingCommand(text.trim())
        }
      } else {
        pendingId = args.onOptimisticSend?.(text, imagePaths)
        if (pendingHandle) {
          args.trackPendingSend(pendingHandle, pendingId)
        }
      }
      emitNativeChatMessageSent({
        agent: args.agent,
        runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
      })
      args.onSubmitted?.()
      if (
        latest.current.draftScopeKey === args.draftScopeKey &&
        latest.current.draft === submitted &&
        readNativeChatComposerDraft(args.draftScopeKey).text === originalDraft.text &&
        sameNativeChatComposerDraftImages(
          readNativeChatComposerDraft(args.draftScopeKey).images,
          originalDraft.images
        ) &&
        latest.current.imageAttachments.length === imagePaths.length &&
        latest.current.imageAttachments.every((image, index) => image.path === imagePaths[index])
      ) {
        args.setDraft('')
        args.setCaret(0)
        args.clearSkillOrigin()
        args.clearImageAttachments()
      }
      args.setNotice(null)
      useAppStore.getState().clearNativeChatLaunchDraft(args.terminalTabId)
    }
    const capturedInput = resolveNativeChatPastedText(args.draftScopeKey, submitted)
    const sources = [
      ...new Set(
        text
          .split(NATIVE_CHAT_PASTED_TEXT_TOKEN)
          .flatMap((token) => nativeChatPastedTextId(token) ?? [])
      )
    ].flatMap((id) => readTerminalPasteSource(id) ?? [])
    if (sources.length === 0) {
      dispatch(capturedInput)
      return
    }
    if (nativeChatComposerTargetIsRemote(target.ptyId)) {
      args.setNotice(nativeChatAttachmentOwnerChangedNotice())
      return
    }
    let cancelled = false
    const done = Promise.withResolvers<void>()
    const preparation: NativeChatSendHandle & { settled: Promise<void> } = {
      cancel: () => {
        cancelled = true
        if (preparing.current === preparation) {
          preparing.current = null
        }
        done.resolve()
      },
      settleAfterMs: 0,
      settled: done.promise
    }
    preparing.current = preparation
    registerNativeChatPtySendPreparation(target.ptyId, preparation)
    args.trackPendingSend(preparation)
    const request = {
      requestId: createUuidV4(),
      scopeKey: args.draftScopeKey,
      ptyId: target.ptyId,
      input: capturedInput,
      sources
    }
    void Promise.resolve()
      .then(() => window.api.ui.materializeTerminalTextInput(request))
      .then(async (paths) => {
        if (
          cancelled ||
          latest.current.draftScopeKey !== args.draftScopeKey ||
          latest.current.resolveTarget()?.ptyId !== target.ptyId
        ) {
          await window.api.ui.retireTerminalTextInput(request).catch(() => {})
          return
        }
        const resolved = resolveNativeChatPastedText(
          args.draftScopeKey,
          capturedInput,
          false,
          paths
        )
        if (resolved.includes('](orca-paste:')) {
          throw new Error('Pasted text could not be prepared.')
        }
        dispatch(resolved)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        args.setNotice(
          nativeChatAttachFailedNotice(
            [nativeChatPastedTextLabel()],
            extractIpcErrorMessage(error, '')
          )
        )
      })
      .finally(() => {
        if (preparing.current === preparation) {
          preparing.current = null
        }
        done.resolve()
      })
  }, [args])
}
