import type { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import { StructuredAgentSessionProviderRetry } from './structured-agent-session-provider-retry'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'

export function createProviderRetry(
  context: () => StructuredAgentSessionMutationContext
): StructuredAgentSessionProviderRetry {
  return new StructuredAgentSessionProviderRetry({
    continueTurn: async (input) => {
      const ctx = context()
      const wait = ctx.acquireAborts.begin(input.sessionId, true)
      try {
        return (
          (await ctx.deps.adapter.continueAfterTransientFailure?.({
            ...input,
            signal: AbortSignal.any([input.signal, wait.signal])
          })) ?? { state: 'refused' }
        )
      } finally {
        wait.end()
      }
    },
    session: (id) => context().sessions.get(id),
    fence: (id) => structuredAgentSessionConversationFence(context().deps.store, id),
    serialize: (id, task) => context().serialize(id, task),
    owesWork: (id) => {
      const ctx = context()
      const work = hostStructuredAgentSessionCurrentWork(
        { store: ctx.deps.store, sessions: ctx.sessions },
        id
      )
      return work === null || work.activeTurnId() !== null || work.owesAnySend()
    },
    publish: (id) => context().publishWorkChanged(id)
  })
}

export function retryEventHandler(
  retry: StructuredAgentSessionProviderRetry,
  context: () => StructuredAgentSessionMutationContext,
  recovery: () => StructuredAgentSessionEventRecovery
): StructuredAgentSessionEventRecovery['handle'] {
  return (event) => {
    if (
      event.type === 'ended' &&
      context().sessions.get(event.sessionId)?.child?.generation === event.acquisitionGeneration
    ) {
      retry.retire(event.sessionId)
    }
    return recovery().handle(event)
  }
}

export function retryClose(
  retry: StructuredAgentSessionProviderRetry,
  lifetime: () => StructuredAgentSessionConversationLifetime
): StructuredAgentSessionConversationLifetime['close'] {
  return (sessionId, cause) => {
    retry.retire(sessionId)
    return lifetime().close(sessionId, cause)
  }
}
