import { translate } from '@/i18n/i18n'
import { useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { conversationSwitchFailureText } from './conversation-switch-feedback'
import { findStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { runningStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { inPlaceSwitchCapabilityNow, useInPlaceSwitchRevision } from './in-place-switch-support'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { refreshLocalStructuredSessionWorktreeTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import {
  pendingNativeChatCliSwitches as pending,
  pendingCliChatResumes,
  subscribeConversationSwitch as subscribe
} from './pending-conversation-surface-switches'
import type { AiVaultSession, AiVaultAgent } from '../../../shared/ai-vault-types'
import type { CliChatResumeSource } from '@/components/tab-bar/cli-chat-resume-source'

export type ConversationSwitch = {
  direction: 'chat' | 'terminal'
  executionHostId: string
  workspaceId: string
  agent: AiVaultAgent
  sessionId?: string
  chatTabId?: string | null
  source?: CliChatResumeSource
  history?: AiVaultSession
  platform?: string
  feedback?: (message: string, kind: 'error' | 'info') => void
}

export const keyFor = (args: ConversationSwitch) =>
  `${args.executionHostId}\0${args.sessionId ?? args.source?.providerSessionId ?? args.history?.sessionId}`

export function pendingNow(args: ConversationSwitch) {
  return (
    pending.has(keyFor(args)) ||
    Boolean(args.sessionId && pending.has(`${args.executionHostId}\0${args.sessionId}`)) ||
    [...pendingCliChatResumes.values()].some(
      ({ source }) =>
        source.executionHostId === args.executionHostId &&
        source.providerSessionId === args.source?.providerSessionId
    )
  )
}

export function useConversationSwitchPending(args: ConversationSwitch | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => Boolean(args && pendingNow(args)),
    () => false
  )
}

export function useConversationSwitchReadiness(args: ConversationSwitch | null) {
  useInPlaceSwitchRevision()
  const target = useMemo(
    () => structuredAgentSessionTargetForHost(args?.executionHostId),
    [args?.executionHostId]
  )
  const reader =
    args?.sessionId && target
      ? findStructuredAgentSessionReadOwner(args.sessionId, target)
      : undefined
  const held = useSyncExternalStore(
    reader?.subscribe ?? subscribe,
    () => reader?.getSnapshot(),
    () => undefined
  )
  const runningTurn = useMemo(
    () =>
      Boolean(
        held?.current &&
        held.state.working !== false &&
        runningStructuredAgentSessionTurnId(held.state)
      ),
    [held]
  )
  const terminalJob = useAppStore((state) => {
    const key = args?.source?.paneKey
    if (!key) {
      return false
    }
    const foreground = state.paneForegroundAgentByPaneKey[key]
    return foreground?.suspendedAgent
      ? 'suspended'
      : foreground?.agent && !foreground.shellForeground
        ? 'live'
        : false
  })
  const pending = useConversationSwitchPending(args)
  const capability = args ? inPlaceSwitchCapabilityNow(args.executionHostId, args.agent) : undefined
  const updateRequired = args?.source?.hostUpdateRequired === true
  const reason = terminalJob ? 'conversationOpenInTerminal' : runningTurn ? 'turnActive' : undefined
  return {
    ready: Boolean(
      args && target && capability !== undefined && !pending && !reason && !updateRequired
    ),
    pending,
    explanation: updateRequired
      ? translate(
          'components.native-chat.resumeInNewChat.hostUpdateRequired',
          'Update Orca on this host to continue in Chat UI.'
        )
      : args && reason
        ? conversationSwitchFailureText(null, args, reason, {
            suspended: terminalJob === 'suspended'
          })
        : undefined
  }
}

export function rederiveConversationSwitch(args: ConversationSwitch): void {
  const target = structuredAgentSessionTargetForHost(args.executionHostId)
  if (!target) {
    return
  }
  if (args.sessionId) {
    findStructuredAgentSessionReadOwner(args.sessionId, target)?.resync?.()
  }
  const refresh =
    target.kind === 'local'
      ? refreshLocalStructuredSessionWorktreeTabs(args.workspaceId, {
          reacceptCurrentVersion: true
        })
      : import('@/runtime/web-runtime-session-snapshot').then(
          ({ refreshWebRuntimeSessionTabsSnapshot }) =>
            refreshWebRuntimeSessionTabsSnapshot(target.environmentId, args.workspaceId, {
              acceptCurrentSnapshot: true,
              afterCurrentInFlight: true
            })
        )
  void refresh.catch(() => {})
}
