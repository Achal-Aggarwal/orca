import type { TuiAgent } from '../../../../shared/tui-agent'
import type { RuntimeDetectedAgentsSlice } from './runtime-detected-agents'

// Keep deduplicated promises outside serializable Zustand state.
export const runtimeDetectPromises = new Map<string, Promise<TuiAgent[]>>()
export const latestOutcome = new Map<string, 'pending' | 'successful' | 'failed'>()
export const runtimeRefreshPromises = new Map<string, Promise<TuiAgent[]>>()

export function withoutKeys<T>(record: Record<string, T>, drop: (key: string) => boolean) {
  let changed = false
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    if (drop(key)) {
      changed = true
    } else {
      next[key] = value
    }
  }
  return changed ? next : record
}

type RuntimeAgentInventoryState = Pick<
  RuntimeDetectedAgentsSlice,
  | 'runtimeDetectedAgentIds'
  | 'isDetectingRuntimeAgents'
  | 'isRefreshingRuntimeAgents'
  | 'runtimeAgentDetectionNeedsServerUpdate'
>

/** Detach pending replies before pruning their settled inventory and outcome records. */
export function retireRuntimeAgentInventories(
  state: RuntimeAgentInventoryState,
  dropKey: (key: string) => boolean
): RuntimeAgentInventoryState {
  for (const cache of [runtimeDetectPromises, runtimeRefreshPromises, latestOutcome]) {
    for (const key of cache.keys()) {
      if (dropKey(key)) {
        cache.delete(key)
      }
    }
  }
  const runtimeDetectedAgentIds = withoutKeys(state.runtimeDetectedAgentIds ?? {}, dropKey)
  const isDetectingRuntimeAgents = withoutKeys(state.isDetectingRuntimeAgents ?? {}, dropKey)
  const isRefreshingRuntimeAgents = withoutKeys(state.isRefreshingRuntimeAgents ?? {}, dropKey)
  const runtimeAgentDetectionNeedsServerUpdate = withoutKeys(
    state.runtimeAgentDetectionNeedsServerUpdate ?? {},
    dropKey
  )
  return runtimeDetectedAgentIds === state.runtimeDetectedAgentIds &&
    isDetectingRuntimeAgents === state.isDetectingRuntimeAgents &&
    isRefreshingRuntimeAgents === state.isRefreshingRuntimeAgents &&
    runtimeAgentDetectionNeedsServerUpdate === state.runtimeAgentDetectionNeedsServerUpdate
    ? state
    : {
        runtimeDetectedAgentIds,
        isDetectingRuntimeAgents,
        isRefreshingRuntimeAgents,
        runtimeAgentDetectionNeedsServerUpdate
      }
}
