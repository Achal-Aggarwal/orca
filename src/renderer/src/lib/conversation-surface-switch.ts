import { toHostSessionPaneKey } from '../../../shared/terminal-surface-id'
import {
  captureSwitchProjection,
  releaseUnsentSwitchProjection
} from './conversation-switch-projection'
import {
  beginSwitchPresentation,
  reportSwitchPresentationFailure,
  settleSwitchPresentation,
  type SwitchPresentationVisit
} from './conversation-switch-presentation'
import { publishAgentLaunchTab } from './agent-launch-tab-publication'
import { openStructuredAgentSessionProvisionalTab } from './structured-agent-session-launch-surface'
import { activateAndRevealWorkspace } from './worktree-activation'
import { afterPendingTab } from '@/runtime/layout-owner-pending-tabs'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  conversationSwitchFailureText,
  conversationSwitchSourceKept
} from './conversation-switch-feedback'
import { resolveWorktreeExecutionHostPlatform } from './execution-host-facts'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  callStructuredAgentSession,
  supportsInPlaceSwitch
} from '@/runtime/structured-agent-session-client'
import { createStructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import { createBrowserUuid } from './browser-uuid'
import { captureSourceTerminal } from '@/components/tab-bar/cli-chat-resume-terminal-capture'
import {
  pendingNativeChatCliSwitches as pending,
  conversationSwitchChanged
} from './pending-conversation-surface-switches'
import {
  agentSessionSwitchDeadline,
  AGENT_SESSION_SWITCH_CLIENT_MS,
  type AgentSessionSwitchResult
} from '../../../shared/agent-session-switch-execution'
import { AgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { prepareAiVaultSessionForResume } from './ai-vault-session-resume-preparation'
import type { CliChatResumeSource } from '@/components/tab-bar/cli-chat-resume-source'
import { runLegacyConversationSwitch } from './conversation-switch-legacy'
import {
  type ConversationSwitch,
  keyFor,
  pendingNow,
  rederiveConversationSwitch
} from './conversation-switch-state'

export { conversationSwitchFailureText } from './conversation-switch-feedback'

export function runCliChatResume(source: CliChatResumeSource): Promise<void> {
  return runConversationSwitch({ direction: 'chat', ...source, source }).then(() => undefined)
}
export function runNativeChatCliSwitch(
  args: Omit<ConversationSwitch, 'direction'> & { onComplete?: () => void }
): Promise<void> {
  return runConversationSwitch({ ...args, direction: 'terminal' })
    .then(() => undefined)
    .finally(args.onComplete)
}

export async function runConversationSwitch(args: ConversationSwitch): Promise<boolean> {
  if (pendingNow(args)) {
    return false
  }
  const platform = resolveWorktreeExecutionHostPlatform(
    useAppStore.getState(),
    args.workspaceId,
    undefined
  )
  args = {
    ...args,
    platform: args.platform ?? (platform.kind === 'known' ? platform.platform : undefined)
  }
  const target = structuredAgentSessionTargetForHost(args.executionHostId)
  const hostId = parseExecutionHostId(args.executionHostId)?.id
  if (!target || !hostId) {
    return false
  }
  const deadline = agentSessionSwitchDeadline(Date.now, AGENT_SESSION_SWITCH_CLIENT_MS)
  const key = keyFor(args)
  const feedback =
    args.feedback ?? ((message: string, kind: 'error' | 'info') => toast[kind](message))
  pending.set(key, {
    chatTabId: args.source?.tabId ?? args.chatTabId ?? null,
    workspaceId: args.workspaceId,
    executionHostId: args.executionHostId
  })
  conversationSwitchChanged()
  const invocationId = createBrowserUuid()
  if (args.direction === 'terminal' && args.sessionId && args.chatTabId) {
    captureSwitchProjection(
      useAppStore.getState(),
      args.workspaceId,
      {
        invocationId,
        generation: invocationId,
        sessionId: args.sessionId,
        tabId: args.chatTabId,
        phase: 'prepare'
      },
      () => {}
    )
  }
  let sent = false
  let observing = false
  let presentation: SwitchPresentationVisit | undefined
  try {
    if (!(await deadline.wait(supportsInPlaceSwitch(target, args.agent, true)))) {
      await runLegacyConversationSwitch(args, target)
      return false
    }
    let sessionId = args.sessionId
    let execution: Record<string, unknown> = { invocationId }
    if (args.direction === 'chat' && args.source) {
      const captured = await deadline.wait(captureSourceTerminal(args.source))
      if (!captured) {
        throw new Error('source unavailable')
      }
      const intent = createStructuredAgentSessionLaunchIntent(
        args.workspaceId,
        'codex',
        args.source.executionHostId,
        {
          providerSessionId: args.source.providerSessionId,
          cliSource: {
            workspaceId: args.workspaceId,
            paneKey: toHostSessionPaneKey(args.source.paneKey)
          }
        }
      )
      sessionId = intent.sessionId
      const group = useAppStore
        .getState()
        .groupsByWorktree[args.workspaceId]?.find((row) =>
          row.tabOrder.includes(args.source!.tabId)
        )
      execution = {
        ...execution,
        create: {
          ...intent.params,
          tabPlacement: { groupId: group?.id, afterTabId: args.source.tabId }
        },
        source: {
          terminal: captured.handle,
          expectedIncarnationId: captured.incarnationId,
          originalPresentation: captured.presentation
        }
      }
    } else if (args.direction === 'chat' && !sessionId && args.history) {
      const prepared = await deadline.wait(prepareAiVaultSessionForResume(args.history))
      const intent = createStructuredAgentSessionLaunchIntent(args.workspaceId, 'codex', hostId, {
        providerSessionId: prepared.sessionId
      })
      sessionId = intent.sessionId
      execution = { ...execution, create: intent.params }
    } else if (args.direction === 'terminal') {
      const state = useAppStore.getState()
      execution = {
        ...execution,
        sourceTabId: args.chatTabId ?? undefined,
        groupId: state.groupsByWorktree[args.workspaceId]?.find((row) =>
          row.tabOrder.includes(args.chatTabId ?? '')
        )?.id,
        commandOverride: state.settings?.agentCmdOverrides?.[args.agent]
      }
    }
    const method =
      args.direction === 'chat' ? 'agentSession.switchToChat' : 'agentSession.switchToTerminal'
    const invoke = (extra: Record<string, unknown> = {}) =>
      deadline.wait(
        callStructuredAgentSession<AgentSessionSwitchResult>(
          target,
          method,
          { sessionId, execution: { ...execution, ...extra } },
          {
            signal: deadline.signal,
            dispatchObservation: deadline.delegateSend,
            beforeSend: (sentAt) => {
              deadline.beforeSend(sentAt)
              sent = true
            }
          }
        )
      )
    let answer = await invoke()
    if (answer.status === 'present') {
      const view = answer
      sessionId = answer.sessionId
      if (view.surface !== 'terminal') {
        presentation = beginSwitchPresentation(target, sessionId)
      }
      const opened =
        view.surface === 'terminal' && view.leafId
          ? {
              id: publishAgentLaunchTab({
                requestId: invocationId,
                operationId: invocationId,
                worktreeId: view.workspaceId,
                tabId: view.tabId,
                leafId: view.leafId,
                launchAgent: view.agent,
                viewMode: 'terminal',
                placement: view.placement,
                viewer: 'focus-window'
              }).tabId
            }
          : openStructuredAgentSessionProvisionalTab({
              worktreeId: answer.workspaceId,
              executionHostId: hostId,
              sessionId,
              agent: answer.agent,
              targetGroupId: answer.placement?.groupId,
              afterTabId: answer.placement?.afterTabId,
              activate: true
            })
      await deadline.wait(
        new Promise<void>((resolve, reject) =>
          afterPendingTab(opened.id, (id) => {
            if (!id || activateAndRevealWorkspace(view.workspaceId) === false) {
              reject(new Error('chat unavailable'))
            } else {
              resolve()
            }
          })
        )
      )
      const shown = presentation ? await deadline.wait(presentation.shown) : true
      answer = await invoke({ receipt: { generation: answer.generation, shown } })
    }
    if (answer.status !== 'completed') {
      if (answer.status === 'present') {
        throw new Error('chat unavailable')
      }
      if (!presentation || reportSwitchPresentationFailure(presentation, answer.failureItemId)) {
        feedback(
          conversationSwitchFailureText(new AgentSessionRefusalError(answer.refusal), args),
          'error'
        )
      }
      return false
    }
    if (answer.sourceRetained) {
      feedback(conversationSwitchSourceKept(args.agent), 'info')
    }
    if (answer.startupPending) {
      observing = true
      const selectedVisit = presentation
      void invoke({ observe: true })
        .then((settled) => {
          if (settled.status === 'completed' && settled.sourceRetained) {
            feedback(conversationSwitchSourceKept(args.agent), 'info')
          }
          if (
            (settled.status === 'refused' || settled.status === 'uncertain') &&
            (!selectedVisit ||
              reportSwitchPresentationFailure(selectedVisit, settled.failureItemId))
          ) {
            feedback(
              conversationSwitchFailureText(new AgentSessionRefusalError(settled.refusal), args),
              'error'
            )
          }
        })
        .catch((error: unknown) => {
          if (deadline.signal.aborted) {
            rederiveConversationSwitch({ ...args, sessionId })
          }
          if (!selectedVisit || reportSwitchPresentationFailure(selectedVisit)) {
            feedback(conversationSwitchFailureText(error, args), 'error')
          }
        })
        .finally(() => {
          settleSwitchPresentation(selectedVisit)
          deadline.dispose()
        })
    }
    return true
  } catch (error) {
    feedback(conversationSwitchFailureText(error, args), 'error')
    return false
  } finally {
    if (!sent) {
      releaseUnsentSwitchProjection(invocationId)
    }
    if (!observing) {
      settleSwitchPresentation(presentation)
      deadline.dispose()
    }
    pending.delete(key)
    conversationSwitchChanged()
    rederiveConversationSwitch(args)
  }
}

export {
  useConversationSwitchPending,
  useConversationSwitchReadiness,
  type ConversationSwitch
} from './conversation-switch-state'
