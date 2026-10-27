import type { AutomationRun } from '../../shared/automations-types'
import { isAgentLaunchResult, type AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { rpcCallerOperationKey } from '../runtime/rpc/rpc-caller-identity'
import { AUTOMATION_AGENT_CALLER, automationRunOperationId } from './automation-run-operation'

export type AutomationRunReceipt =
  | { kind: 'chat'; sessionId: string; workspaceId: string; messageId: string }
  | {
      kind: 'terminal'
      launch: AgentLaunchResult & {
        outcome: Extract<AgentLaunchResult['outcome'], { kind: 'terminal' }>
      }
    }

/** Recover only recorded acceptance; a restart never sends the prompt again. */
export function readAutomationRunReceipt(
  store: Pick<AgentSessionRecordStore, 'getOperationRow' | 'getConversation'>,
  run: Pick<AutomationRun, 'id' | 'createdAt'>
): AutomationRunReceipt | null {
  const callerKey = rpcCallerOperationKey(AUTOMATION_AGENT_CALLER)
  for (const purpose of ['fresh-launch', 'reuse-terminal-launch'] as const) {
    const row = store.getOperationRow(callerKey, automationRunOperationId(run, purpose))
    if (!row) {
      continue
    }
    if (row.outcome.status !== 'succeeded' || !isAgentLaunchResult(row.outcome.launch)) {
      return null
    }
    const launch = row.outcome.launch
    if (launch.outcome.kind === 'structured' && launch.prompt?.outcome === 'journaled') {
      return {
        kind: 'chat',
        sessionId: launch.outcome.sessionId,
        workspaceId: launch.worktreeId,
        messageId: launch.prompt.messageId
      }
    }
    if (launch.outcome.kind === 'terminal' && launch.prompt?.outcome === 'handed-to-terminal') {
      return { kind: 'terminal', launch: { ...launch, outcome: launch.outcome } }
    }
    return null
  }
  const messageId = automationRunOperationId(run, 'reuse-send')
  const send = store.getOperationRow(callerKey, messageId)
  if (send?.outcome.status !== 'succeeded') {
    return null
  }
  const conversation = store.getConversation(send.outcome.sessionId)
  return conversation
    ? {
        kind: 'chat',
        sessionId: send.outcome.sessionId,
        workspaceId: conversation.location.workspaceId,
        messageId
      }
    : null
}
