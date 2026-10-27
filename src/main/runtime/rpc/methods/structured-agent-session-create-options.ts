import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-chat-permission-mode'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../../shared/agent-session-wire'
import type {
  StructuredAgentSessionResumeSource,
  StructuredAgentSessionFirstMessage
} from '../../../../shared/structured-agent-session-create'

export function structuredAgentSessionCreateIntentFingerprint(params: {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: string
  resumeFrom?: StructuredAgentSessionResumeSource
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  options?: Readonly<Record<string, string>>
}): string {
  return computeAgentSessionPayloadFingerprint({
    method: 'agentSession.create',
    sessionId: params.envelope.sessionId,
    fields: {
      worktree: params.worktree,
      agent: params.agent,
      resumeFrom: params.resumeFrom,
      tabId: params.tabId,
      firstMessage: params.firstMessage,
      options: params.options
    }
  })
}

export function seededPermissionMode(
  options: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const mode = options?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
  return mode ? { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: mode } : {}
}
