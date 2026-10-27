import { agentPromptInterruptInput } from './agent-prompt-interrupt-input'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'

export function agentPromptObservationSignal(
  options: RuntimeAgentPromptWriteOptions
): AbortSignal | undefined {
  return options.signal && options.observationSignal
    ? AbortSignal.any([options.signal, options.observationSignal])
    : (options.signal ?? options.observationSignal)
}

/** First-submit authority ends at Enter; a disconnected observer cannot interrupt admitted input. */
export function agentPromptFirstSubmitScope(
  options: RuntimeAgentPromptWriteOptions,
  subscribeInput: (listener: (data: string) => void) => () => void,
  subscribeExit: (listener: () => void) => () => void
): { admission: AbortSignal; delivery: AbortSignal; dispose: () => void } {
  const stopped = new AbortController()
  const delivery = options.signal
    ? AbortSignal.any([options.signal, stopped.signal])
    : stopped.signal
  const observation = agentPromptObservationSignal(options)
  const admission = observation ? AbortSignal.any([observation, stopped.signal]) : delivery
  const unsubscribeInput = subscribeInput(agentPromptInterruptInput(() => stopped.abort()))
  const unsubscribeExit = subscribeExit(() => stopped.abort())
  return {
    admission,
    delivery,
    dispose: () => {
      unsubscribeInput()
      unsubscribeExit()
    }
  }
}
