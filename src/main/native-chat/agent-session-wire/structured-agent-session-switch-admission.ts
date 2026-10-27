import {
  agentSessionLeaseOwnerVerdict,
  agentSessionLeasePossiblyWriting
} from '../../../shared/agent-session-lease-adjudication'
import { heldStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  agentSessionRefusalError,
  isAgentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

// The chat's half of a switch to its terminal. Unlike a tab close, a switch never cuts work short
// (the user stops a reply first), so it is admitted only when the chat is idle, and its admission
// has no effect of its own: no start is aborted and nothing is stopped before it passes.

export type SwitchBlockedReason =
  | 'turnActive'
  | 'providerStarting'
  | 'messagesUnsettled'
  | 'backgroundTasksRunning'
  | 'handoffInFlight'
  | 'previousExitUnverifiable'

export function structuredAgentSessionSwitchBlocked(input: {
  session?: StructuredAgentSessionHostSession
  deps: StructuredAgentSessionHostDeps
  sessionId: string
  delivering: boolean
  starting?: boolean
  background: boolean
  ownCommand?: boolean
  joinStart?: boolean
}): SwitchBlockedReason | null {
  const { session, deps, sessionId } = input
  const record = deps.store.getRecord(sessionId)
  if (!input.ownCommand && session?.switchCommand) {
    return 'handoffInFlight'
  }
  if (session?.child?.close) {
    return 'handoffInFlight'
  }
  if (!input.joinStart && (input.starting || session?.child?.phase === 'starting')) {
    return 'providerStarting'
  }
  if (input.background) {
    return 'backgroundTasksRunning'
  }
  const work = session?.child
    ? heldStructuredAgentSessionCurrentWork(deps.store, sessionId, session.journal, session)
    : null
  if (work?.activeTurnId()) {
    return 'turnActive'
  }
  if (
    input.delivering ||
    work?.holdsHandedOverSend() ||
    (record && (deps.hasOwedSwitchWork ?? deps.hasOpenDispatch)?.(record)) ||
    session?.journal.submissions().some(isQueuedAgentJournalSubmission)
  ) {
    return 'messagesUnsettled'
  }
  if (!session?.child && record && agentSessionLeasePossiblyWriting(record.lease)) {
    return 'previousExitUnverifiable'
  }
  return null
}

/** In the chat's ordered step: refuses unless nothing is running, starting, queued or owed, then
 *  admits, stops through close's body, and proves the agent gone before anything starts elsewhere. */
export async function stopIdleStructuredAgentSessionForSwitch(input: {
  session: StructuredAgentSessionHostSession | undefined
  delivering: boolean
  idleSweep: {
    owesWork: (sessionId: string, session: StructuredAgentSessionHostSession) => boolean
  }
  stop: () => Promise<unknown>
  deps: StructuredAgentSessionHostDeps
  sessionId: string
  check?: () => void
  ownCommand?: boolean
  background?: boolean
}): Promise<void> {
  const { session, deps, sessionId, stop } = input
  if (!input.check) {
    const record = deps.store.getRecord(sessionId)
    if (
      input.delivering ||
      (record && (deps.hasOwedSwitchWork ?? deps.hasOpenDispatch)?.(record)) ||
      (session &&
        (session.child?.phase === 'starting' ||
          session.journal.submissions().some(isQueuedAgentJournalSubmission) ||
          (session.child !== null && input.idleSweep.owesWork(sessionId, session))))
    ) {
      throw agentSessionRefusalError('agent_session_operation_invalid', { reason: 'turnActive' })
    }
  } else {
    input.check()
    const reason = structuredAgentSessionSwitchBlocked({
      ...input,
      background: input.background ?? false
    })
    if (reason === 'previousExitUnverifiable') {
      throw agentSessionRefusalError('agent_session_ownership_unknown', { reason })
    }
    if (reason) {
      throw agentSessionRefusalError('agent_session_operation_invalid', { reason })
    }
    if (session?.child && input.idleSweep.owesWork(sessionId, session)) {
      throw agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'backgroundTasksRunning'
      })
    }
  }
  try {
    await stop()
  } catch (error) {
    if (
      !input.check ||
      (isAgentSessionRefusalError(error) &&
        error.refusal.code === 'agent_session_operation_expired')
    ) {
      throw error
    }
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
  }
  const lease = deps.store.getRecord(sessionId)?.lease
  if (
    !lease ||
    (input.check
      ? agentSessionLeasePossiblyWriting(lease)
      : agentSessionLeaseOwnerVerdict(lease) !== 'exited')
  ) {
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
  }
}
