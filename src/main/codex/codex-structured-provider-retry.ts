import { agentSessionExecutionOptionsRecord } from '../../shared/agent-session-execution-options'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionInputNotAdmitted } from '../native-chat/agent-session-wire/structured-agent-session-input-admission'
import { isCodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import { codexTurnRequestOptions } from './codex-structured-service-tier'
import type { CodexSession } from './codex-structured-session-state'
import { readCodexTurnId } from './codex-structured-thread-facts'
import { admitCodexTurnPermission } from './codex-structured-turn-permission'

export async function continueCodexAfterTransientFailure(
  session: CodexSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['continueAfterTransientFailure']>>[0],
  timeoutMs = 5_000
): ReturnType<NonNullable<StructuredAgentSessionAdapter['continueAfterTransientFailure']>> {
  if (
    session.fence !== input.fence ||
    input.signal.aborted ||
    (session.activeTurnIds?.size ?? 0) > 0
  ) {
    return { state: 'refused' }
  }
  try {
    const options = input.options
      ? agentSessionExecutionOptionsRecord(input.options)
      : Object.fromEntries(session.options)
    const answer = await waitForPromiseWithSignal(
      admitCodexTurnPermission(
        session,
        undefined,
        (permission) => {
          input.signal.throwIfAborted()
          return {
            kind: 'sent',
            response: session.connection.request(
              'turn/start',
              {
                threadId: session.threadId,
                input: [],
                ...permission,
                ...codexTurnRequestOptions({
                  ...session,
                  options: new Map(Object.entries(options))
                })
              },
              { timeoutMs }
            )
          }
        },
        input.signal
      ),
      input.signal
    )
    const turnId = readCodexTurnId(answer)
    if (!turnId) {
      return { state: 'unknown' }
    }
    if (!session.dispatchEchoes.hasOpened(session.threadId, turnId)) {
      await waitForPromiseWithSignal(session.turnOpenWaits.wait(turnId, timeoutMs), input.signal)
    }
    return session.dispatchEchoes.hasOpened(session.threadId, turnId)
      ? { state: 'started', providerTurnRef: turnId }
      : { state: 'unknown' }
  } catch (error) {
    return {
      state:
        isCodexAppServerRequestError(error) ||
        error instanceof StructuredAgentSessionInputNotAdmitted
          ? 'refused'
          : 'unknown'
    }
  }
}
