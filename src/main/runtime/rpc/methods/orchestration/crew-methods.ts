import { z } from 'zod'
import { CrewParty } from '../../../../../shared/orchestration-crew'
import { sessionCrewChanges } from '../../../orchestration/crew/crew-changes'
import { subscribeCrew } from '../../../orchestration/crew/crew-stream'
import { defineStreamingMethod } from '../../core'

let sequence = 0
export const ORCHESTRATION_CREW_METHODS = [
  defineStreamingMethod({
    name: 'orchestration.crewSubscribe',
    permission: 'workspace',
    params: z.object({ party: CrewParty }),
    handler: async ({ party }, { runtime, signal, connectionId }, emit) => {
      await new Promise<void>((resolve) => {
        const key = `crew:${connectionId ?? 'local'}:${++sequence}`
        const release = () => runtime.cleanupSubscription(key)
        const stop = subscribeCrew(
          () => runtime.getOrchestrationCrewSnapshot(party),
          (wake) => {
            const disposers = [
              runtime.crewChanges.subscribe(wake),
              sessionCrewChanges.subscribe(wake),
              runtime.agentTransitions.subscribe(wake),
              runtime.onClientEvent((event) => {
                if (event.type === 'terminalSideEffects' || event.type === 'workspaceViewChanged') {
                  wake()
                }
              })
            ]
            return () => disposers.forEach((dispose) => dispose())
          },
          emit
        )
        runtime.registerSubscriptionCleanup(
          key,
          () => {
            stop()
            signal?.removeEventListener('abort', release)
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )
        signal?.addEventListener('abort', release, { once: true })
        if (signal?.aborted) {
          release()
        }
      })
    }
  })
]
