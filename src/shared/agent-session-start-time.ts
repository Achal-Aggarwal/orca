import type { AgentStatusEntry } from './agent-status-types'
import { agentProviderSessionsEqual } from './agent-session-resume'
import { sameAgentStatusTerminalOwner } from './agent-status-terminal-owner'

type SessionIdentity = Pick<
  AgentStatusEntry,
  'agentType' | 'providerSession' | 'connectionId' | 'worktreeId'
>

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function agentEntrySessionStartedAt(
  entry: Pick<AgentStatusEntry, 'firstStateStartedAt' | 'stateHistory' | 'stateStartedAt'>
): number {
  return (
    finite(entry.firstStateStartedAt) ??
    finite(entry.stateHistory[0]?.startedAt) ??
    entry.stateStartedAt
  )
}

/** Missing identity enriches a row; only accepted contradictory identity starts another session. */
export function resolveAgentSessionStartedAt(args: {
  entry: AgentStatusEntry
  previous?: AgentStatusEntry
  previousStartedAt?: number
  identity?: SessionIdentity
  replacementStartedAt: number
}): number {
  const { entry, previous, previousStartedAt, identity = entry, replacementStartedAt } = args
  if (!previous) {
    return agentEntrySessionStartedAt(entry)
  }
  const agentChanged =
    previous.agentType &&
    previous.agentType !== 'unknown' &&
    identity.agentType &&
    identity.agentType !== 'unknown' &&
    previous.agentType !== identity.agentType
  const sessionChanged =
    previous.providerSession &&
    identity.providerSession &&
    !agentProviderSessionsEqual(
      identity.agentType,
      {
        ...previous.providerSession,
        transcriptPath:
          previous.providerSession.transcriptPath ?? identity.providerSession.transcriptPath
      },
      {
        ...identity.providerSession,
        transcriptPath:
          identity.providerSession.transcriptPath ?? previous.providerSession.transcriptPath
      }
    )
  const worktreeChanged =
    previous.worktreeId &&
    identity.worktreeId &&
    !sameAgentStatusTerminalOwner(
      { worktreeId: previous.worktreeId, connectionId: null },
      { worktreeId: identity.worktreeId, connectionId: null }
    )
  const connectionChanged =
    previous.connectionId !== undefined &&
    identity.connectionId !== undefined &&
    !sameAgentStatusTerminalOwner(previous, identity)
  if (agentChanged || sessionChanged || worktreeChanged || connectionChanged) {
    return finite(replacementStartedAt) ?? entry.updatedAt
  }
  return (
    finite(previous.firstStateStartedAt) ??
    finite(previousStartedAt) ??
    agentEntrySessionStartedAt(previous)
  )
}
