import {
  conversationSwitchChanged,
  pendingNativeChatCliSwitches as pending
} from '@/lib/pending-conversation-surface-switches'
import { conversationSwitchFailureText } from '@/lib/conversation-switch-feedback'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { buildAiVaultResumeStartupForWorktree } from '@/lib/ai-vault-resume-command'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import {
  callStructuredAgentSession,
  supportsInPlaceSwitch
} from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { AiVaultChatForkSourceSchema } from '../../../../shared/ai-vault-chat-fork-contract'
import type { AiVaultAgent } from '../../../../shared/ai-vault-types'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { parseExecutionHostId } from '../../../../shared/execution-host'

const changed = conversationSwitchChanged
/** Moves a chat's conversation into a terminal on the same id: the host stops the idle chat, the
 *  terminal opens in the chat's slot, then the chat tab closes. `chatTabId` null opens a new tab. */
export async function runLegacyNativeChatCliSwitch(args: {
  sessionId: string
  workspaceId: string
  executionHostId: string
  agent: AiVaultAgent
  chatTabId: string | null
  onComplete?: () => void
}): Promise<void> {
  const key = `${args.executionHostId}\0${args.sessionId}\0legacy`
  const target = structuredAgentSessionTargetForHost(args.executionHostId)
  const hostId = parseExecutionHostId(args.executionHostId)?.id
  if (pending.has(key) || !target || !hostId) {
    return
  }
  pending.set(key, args)
  try {
    changed()
    if (
      getExecutionHostIdForWorktree(useAppStore.getState(), args.workspaceId) !==
      args.executionHostId
    ) {
      throw new Error('source unavailable')
    }
    // Fail closed: a host that doesn't advertise the switch never receives it.
    if (!(await supportsInPlaceSwitch(target, args.agent))) {
      throw new Error(
        conversationSwitchFailureText(null, { agent: args.agent, direction: 'terminal' })
      )
    }
    const answered = await callStructuredAgentSession<{ source: unknown }>(
      target,
      'agentSession.switchToTerminal',
      { sessionId: args.sessionId }
    )
    const source = AiVaultChatForkSourceSchema.parse(answered.source)
    const state = useAppStore.getState()
    const startup = buildAiVaultResumeStartupForWorktree({
      state,
      worktreeId: args.workspaceId,
      session: { ...source, executionHostId: hostId },
      commandOverride: state.settings?.agentCmdOverrides?.[source.agent]
    })
    const launch = launchAiVaultSessionInNewTab({
      agent: source.agent,
      worktreeId: args.workspaceId,
      ...startup,
      ...(args.chatTabId ? { afterTabId: args.chatTabId } : {}),
      resumeOrigin: 'switch'
    })
    const outcome = launch.tabId === null ? await launch.runtimeLaunch : null
    if (outcome && outcome.status !== 'created') {
      throw new Error(outcome.status === 'failed' ? outcome.message : undefined)
    }
    // The execution host retires only the source presentation after its explicit admitted result.
    // A tab allocation or generic create receipt says nothing about admission.
  } catch (error) {
    toast.error(conversationSwitchFailureText(error, { agent: args.agent, direction: 'terminal' }))
  } finally {
    pending.delete(key)
    try {
      useAppStore.setState((state) => ({
        agentConversationsByPaneKey: state.agentConversationsByPaneKey
      }))
    } finally {
      try {
        changed()
      } finally {
        args.onComplete?.()
      }
    }
  }
}
