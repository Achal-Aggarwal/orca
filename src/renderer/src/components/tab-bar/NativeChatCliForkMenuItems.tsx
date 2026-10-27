import {
  useConversationSwitchReadiness,
  runNativeChatCliSwitch
} from '@/lib/conversation-surface-switch'
import { useShallow } from 'zustand/react/shallow'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/AiVaultSessionSurfaceSwitchMenuItems'
import {
  resolveNativeChatCliForkIdentity,
  resolveTabSessionHistorySubject,
  type NativeChatTabSession
} from './tab-session-history-switch'
import { runNativeChatCliFork, useNativeChatCliForkPending } from './native-chat-cli-fork-run'
import { useInPlaceSwitchCapability } from '@/lib/in-place-switch-support'

/** "Switch to CLI" where the chat's host switches its agent in place; otherwise the fork. */
export function NativeChatCliForkMenuItems({
  tab,
  nativeChat,
  leadingSeparator,
  onComplete
}: {
  tab: { id: string; worktreeId: string }
  nativeChat: NativeChatTabSession
  leadingSeparator: boolean
  onComplete?: () => void
}): React.JSX.Element | null {
  const chat = useAppStore(
    useShallow((state) => resolveNativeChatCliForkIdentity(state, { tab, nativeChat }))
  )
  const forkPending = useNativeChatCliForkPending(
    chat ? { executionHostScope: chat.executionHostScope, sessionId: chat.sessionId } : null
  )
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
  const inPlace = useInPlaceSwitchCapability(chat?.executionHostScope, agent)
  const readiness = useConversationSwitchReadiness(
    chat && agent
      ? {
          direction: 'terminal',
          sessionId: chat.sessionId,
          agent,
          workspaceId: chat.workspaceId,
          executionHostId: chat.executionHostScope,
          chatTabId: tab.id
        }
      : null
  )
  const enabled = useAppStore((state) => isNativeChatEnabled(state.settings))
  if (!chat || !agent || !enabled) {
    return null
  }
  return (
    <>
      {leadingSeparator ? <DropdownMenuSeparator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        action="switch"
        menuKind="dropdown"
        tooltipSide="right"
        cliPending={inPlace !== false ? readiness.pending : forkPending}
        switchLoading={inPlace !== false && !readiness.ready}
        switchExplanation={readiness.explanation}
        {...(inPlace !== false ? { inPlaceAgent: agent } : {})}
        onResumeInNewCli={(event) => {
          event.preventDefault()
          void (inPlace === true
            ? runNativeChatCliSwitch({
                sessionId: chat.sessionId,
                workspaceId: chat.workspaceId,
                executionHostId: chat.executionHostScope,
                agent,
                chatTabId: tab.id,
                onComplete
              })
            : (() => {
                const subject = resolveTabSessionHistorySubject(useAppStore.getState(), {
                  tab,
                  nativeChat
                })
                return subject?.kind === 'chat'
                  ? runNativeChatCliFork({ subject, tab, agent, commandOverrides, onComplete })
                  : Promise.resolve()
              })())
        }}
      />
    </>
  )
}
