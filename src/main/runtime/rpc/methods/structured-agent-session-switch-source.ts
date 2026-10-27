import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { z } from 'zod'
import type { RpcContext } from '../core'

import type { SwitchToChatParams } from './structured-agent-session-schemas'
import type { agentSessionSwitchDeadline } from '../../../../shared/agent-session-switch-execution'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'

import type { AgentSessionWireRefusal } from '../../../../shared/agent-session-wire'

/** The switch alone owns this captured-shell cleanup; ordinary Close keeps its semantics. */
export async function cleanupSwitchedSourceShell(
  ctx: RpcContext,
  source: NonNullable<NonNullable<z.infer<typeof SwitchToChatParams>['execution']>['source']>,
  witness: string | undefined,
  witnessBudget: number,
  deadline: ReturnType<typeof agentSessionSwitchDeadline>
): Promise<boolean> {
  try {
    deadline.check()
    if (!witness) {
      return false
    }
    return await ctx.runtime.closeSwitchedSourceTerminal(
      source.terminal,
      source.expectedIncarnationId,
      { token: witness, remainingMs: witnessBudget }
    )
  } catch {
    return false
  }
}

export function recordWorkspace(host: StructuredAgentSessionHost, id: string) {
  const record = host.deps.store.getRecord(id)
  if (!record) {
    throw agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
  }
  return record.location.workspaceId
}

export function switchRetainedOwner(
  host: StructuredAgentSessionHost,
  create: NonNullable<NonNullable<z.infer<typeof SwitchToChatParams>['execution']>['create']>,
  refusal: AgentSessionWireRefusal
): string | null {
  if (
    refusal.code !== 'agent_session_conflict' &&
    refusal.code !== 'agent_session_ownership_unknown'
  ) {
    return null
  }
  const owner = refusal.details?.owner
  if (!owner || !create.resumeFrom?.providerSessionId) {
    return null
  }
  const record = host.deps.store.getRecord(owner.sessionId)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  return record?.provider === create.agent &&
    head?.handle.nativeId === create.resumeFrom.providerSessionId &&
    record.location.executionHostId === 'local' &&
    !record.location.wslDistro &&
    owner.workspaceId === record.location.workspaceId
    ? owner.sessionId
    : null
}
