import { useCallback, useEffect, useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import {
  hasAgentTurnStartHook,
  resolveAgentHookSource
} from '../../../../shared/agent-hook-listener/provider-turn-start'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  pendingSendsAsMessages,
  prunePendingSends,
  releaseEmptyTranscriptClaims,
  type NativeChatPendingSend
} from '../../../../shared/native-chat-pending-sends'
import {
  appendPendingSendCache,
  nextNativeChatPendingSendId,
  readPendingSendCache,
  reconcilePendingAgentAcceptance,
  writePendingSendCache
} from './native-chat-pending'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import type { ReadState } from './native-chat-live-session-contract'

/** Wait for transcript evidence after lost write acknowledgment; mobile uses the same hold. */
export const NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS = 20_000

const NO_NOTICES: ReadonlyMap<string, NativeChatDeliveryNotice> = new Map()

/** Keep optimistic PTY echoes and definite transport outcomes until reconciliation. */
export function useNativeChatPendingDelivery(args: {
  paneKey: string
  agent: AgentType
  /** `readPhase` 'ready' with a `sessionId` means an empty `messages` was a real read. */
  session: {
    messages: NativeChatMessage[]
    readPhase?: ReadState['phase']
    sessionId?: string | null
  }
}) {
  const { paneKey, agent } = args
  const hookState = useAppStore((store) => {
    const row = store.agentStatusByPaneKey[paneKey]
    return !row?.agentType ||
      resolveAgentHookSource(row.agentType) === resolveAgentHookSource(agent)
      ? row?.state
      : undefined
  })
  const turnStartedAt = useAppStore((store) => store.agentStatusByPaneKey[paneKey]?.turnStartedAt)
  const { messages } = args.session
  const sessionId = args.session.sessionId ?? null
  // Without a sessionId, ready is an unread placeholder.
  const readEmptySessionId =
    args.session.readPhase === 'ready' && messages.length === 0 ? sessionId : null
  const scope = useMemo(() => ({ paneKey, agent }), [paneKey, agent])
  const [cachedPending, setPending] = useState(() => readPendingSendCache(scope))
  const pending = useMemo(
    () => releaseEmptyTranscriptClaims(cachedPending, sessionId),
    [cachedPending, sessionId]
  )
  useEffect(() => setPending(readPendingSendCache(scope)), [scope])
  const save = useCallback(
    (update: (entries: NativeChatPendingSend[]) => NativeChatPendingSend[]) => {
      const current = readPendingSendCache(scope)
      const next = update(current)
      // Stream pruning runs frequently; no-op updates must not rerender the list.
      if (next !== current) {
        setPending(writePendingSendCache(scope, next))
      }
    },
    [scope]
  )
  useEffect(() => {
    save((entries) => reconcilePendingAgentAcceptance(entries, hookState, turnStartedAt))
  }, [hookState, turnStartedAt, save])
  useEffect(() => {
    save((entries) => prunePendingSends(releaseEmptyTranscriptClaims(entries, sessionId), messages))
  }, [messages, save, sessionId])
  const record = useCallback(
    (text: string, imagePaths?: string[]) => {
      const sentAt = Date.now()
      const boundary = messages.at(-1)
      const candidate = useAppStore.getState().agentStatusByPaneKey[paneKey]
      const row =
        !candidate?.agentType ||
        resolveAgentHookSource(candidate.agentType) === resolveAgentHookSource(agent)
          ? candidate
          : undefined
      const entry: NativeChatPendingSend = {
        id: nextNativeChatPendingSendId(sentAt),
        text,
        sentAt,
        ...(hasAgentTurnStartHook(agent)
          ? {
              agentAcceptance: {
                baselineState: row?.state,
                turnStartedAt: row?.turnStartedAt,
                observedWorking: row?.state === 'working'
              }
            }
          : {}),
        afterMessageId: boundary?.id ?? null,
        afterMessageTimestamp: boundary?.timestamp ?? null,
        ...(readEmptySessionId ? { afterEmptyTranscriptSessionId: readEmptySessionId } : {}),
        ...(imagePaths ? { imagePaths } : {})
      }
      setPending(appendPendingSendCache(scope, entry))
      return entry.id
    },
    [messages, readEmptySessionId, scope, paneKey, agent]
  )
  const cancel = useCallback(
    (id: string) => save((entries) => entries.filter((entry) => entry.id !== id)),
    [save]
  )
  const reject = useCallback(
    (id: string) =>
      save((entries) =>
        entries.map((entry) => (entry.id === id ? { ...entry, delivery: 'rejected' } : entry))
      ),
    [save]
  )
  const holdUnconfirmed = useCallback(
    (id: string) =>
      save((entries) =>
        entries.map((entry) =>
          entry.id === id &&
          !entry.delivery &&
          !entry.agentAcceptance?.accepted &&
          entry.writeUnconfirmedAt === undefined
            ? { ...entry, writeUnconfirmedAt: Date.now() }
            : entry
        )
      ),
    [save]
  )
  const confirmWrite = useCallback(
    (id: string) => {
      const entry = readPendingSendCache(scope).find((entry) => entry.id === id)
      if (entry?.agentAcceptance && entry.agentAcceptance.baselineState !== 'working') {
        holdUnconfirmed(id)
      }
    },
    [scope, holdUnconfirmed]
  )
  // Stop cannot cancel a settled failure; its bubble holds the only message copy.
  const clear = useCallback(
    () => save((entries) => entries.filter((entry) => entry.delivery)),
    [save]
  )

  // Accepted turns cancel the hold; working-baseline sends can be queued without a new turn.
  const nextHoldDeadline = useMemo(() => {
    const deadlines = pending.flatMap((entry) =>
      entry.writeUnconfirmedAt !== undefined && !entry.delivery
        ? [entry.writeUnconfirmedAt + NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS]
        : []
    )
    return deadlines.length > 0 ? Math.min(...deadlines) : null
  }, [pending])
  useEffect(() => {
    if (nextHoldDeadline === null) {
      return
    }
    const timer = setTimeout(
      () => {
        const now = Date.now()
        save((entries) => {
          const due = entries.filter(
            (entry) =>
              entry.writeUnconfirmedAt !== undefined &&
              !entry.delivery &&
              entry.writeUnconfirmedAt + NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS <= now
          )
          if (due.length === 0) {
            return entries
          }
          const unmatched = new Set(
            pendingSendsAsMessages(releaseEmptyTranscriptClaims(due, sessionId), messages).map(
              (message) => message.id
            )
          )
          if (unmatched.size === 0) {
            return entries
          }
          return entries.map((entry) =>
            due.includes(entry) && unmatched.has(`pending:${entry.id}`)
              ? { ...entry, delivery: 'unconfirmed' as const }
              : entry
          )
        })
      },
      Math.max(0, nextHoldDeadline - Date.now())
    )
    return () => clearTimeout(timer)
  }, [nextHoldDeadline, messages, save, sessionId])

  const notices = useMemo(() => {
    if (!pending.some((entry) => entry.delivery)) {
      return NO_NOTICES
    }
    const result = new Map<string, NativeChatDeliveryNotice>()
    for (const entry of pending) {
      if (!entry.delivery) {
        continue
      }
      result.set(`pending:${entry.id}`, {
        text:
          entry.delivery === 'rejected'
            ? translate('components.native-chat.messageNotSent', 'Message not sent')
            : translate(
                'components.native-chat.deliveryUnconfirmed',
                'Delivery unconfirmed — check chat before retrying'
              ),
        onDismiss: () => cancel(entry.id)
      })
    }
    return result
  }, [pending, cancel])
  return { pending, record, cancel, reject, holdUnconfirmed, confirmWrite, clear, notices }
}
