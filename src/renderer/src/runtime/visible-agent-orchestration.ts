import type { AppState } from '@/store/types'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { getStructuredAgentSessionTabs } from '@/components/native-chat/structured-agent-session-tabs'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import type { AgentStatusOrchestrationContext } from '../../../shared/agent-status-types'
import { orchestrationContextsEqual } from '@/store/slices/agent-status/agent-status-orchestration-context'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionOwnerInputs
} from './structured-agent-session-owner'

type Contexts = Record<string, AgentStatusOrchestrationContext>
export type VisibleOrchestrationState = WorktreeRuntimeOwnerState &
  Partial<
    Pick<
      AppState,
      | 'unifiedTabsByWorktree'
      | 'agentStatusByPaneKey'
      | 'retainedAgentsByPaneKey'
      | 'runtimeAgentOrchestrationByPaneKey'
    >
  >
const EMPTY = {}
const producerByContext = new WeakMap<AgentStatusOrchestrationContext, string>()
export function orchestrationProducer(context: AgentStatusOrchestrationContext): string {
  return producerByContext.get(context) ?? LOCAL_EXECUTION_HOST_ID
}
export function recordOrchestrationProducer(
  context: AgentStatusOrchestrationContext,
  host: string
): void {
  producerByContext.set(context, host)
}
type RowIdentities = {
  inputs: unknown[]
  aliases: Map<string, string>
  canonical: Map<string, { key: string; host: string | null }>
  worktrees: Map<string, string>
}
let rowCache: RowIdentities | undefined
let cache: { inputs: unknown[]; contexts: Contexts } | undefined
let builds = 0
let aliasBuilds = 0
let visits = 0
export function visibleOrchestrationWorkForTest(): {
  builds: number
  aliasBuilds: number
  visits: number
} {
  return { builds, aliasBuilds, visits }
}
const aliasKey = (host: string, key: string) => `${host}\0${key}`

function rowIdentities(state: VisibleOrchestrationState): RowIdentities {
  const inputs = [state.unifiedTabsByWorktree, ...structuredAgentSessionOwnerInputs(state)]
  if (rowCache && inputs.every((value, index) => value === rowCache?.inputs[index])) {
    return rowCache
  }
  aliasBuilds++
  const aliases = new Map<string, string>()
  const worktrees = new Map<string, string>()
  const canonical = new Map<string, { key: string; host: string | null }>()
  for (const tab of getStructuredAgentSessionTabs(state.unifiedTabsByWorktree ?? EMPTY)) {
    visits++
    if (!tab.entityId) {
      continue
    }
    const key = structuredAgentSessionPaneKey(
      structuredAgentSessionTabId(tab.entityId),
      tab.entityId
    )
    const actual = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    const host = structuredAgentSessionOwnerForTab(state, tab)
    canonical.set(actual, { key, host })
    worktrees.set(actual, tab.worktreeId)
    if (host && !aliases.has(aliasKey(host, key))) {
      aliases.set(aliasKey(host, key), actual)
    }
  }
  rowCache = { inputs, aliases, canonical, worktrees }
  return rowCache
}

function projection(state: VisibleOrchestrationState): NonNullable<typeof cache> {
  const rows = rowIdentities(state)
  const inputs = [
    state.runtimeAgentOrchestrationByPaneKey,
    state.agentStatusByPaneKey,
    state.retainedAgentsByPaneKey,
    rows
  ]
  if (cache && inputs.every((value, index) => value === cache?.inputs[index])) {
    return cache
  }
  builds++
  const { aliases, canonical } = rows
  const contexts: Contexts = Object.fromEntries([])
  const visibleKey = (key: string, host: string | null) => {
    if (!host) {
      return canonical.has(key) ? aliasKey('unknown', key) : key
    }
    const alias = aliases.get(aliasKey(host, key))
    // An identically spelled row from another runtime cannot satisfy this relationship.
    return (
      alias ?? (canonical.has(key) && canonical.get(key)?.host !== host ? aliasKey(host, key) : key)
    )
  }
  const adapt = (key: string, context: AgentStatusOrchestrationContext, host: string | null) => {
    visits++
    const actual = visibleKey(key, host)
    const parent = context.parentPaneKey ? visibleKey(context.parentPaneKey, host) : undefined
    const next = parent === context.parentPaneKey ? context : { ...context, parentPaneKey: parent }
    const previous = cache?.contexts[actual]
    contexts[actual] =
      next !== context && previous && orchestrationContextsEqual(previous, next) ? previous : next
  }
  for (const [key, context] of Object.entries(state.runtimeAgentOrchestrationByPaneKey ?? EMPTY)) {
    adapt(key, context, producerByContext.get(context) ?? LOCAL_EXECUTION_HOST_ID)
  }
  const embedded = (
    entry: AppState['agentStatusByPaneKey'][string],
    worktreeId = entry.worktreeId
  ) => {
    visits++
    if (!entry?.orchestration) {
      return
    }
    const row = canonical.get(entry.paneKey)
    const runtime = state.runtimeAgentOrchestrationByPaneKey?.[row?.key ?? entry.paneKey]
    const host = row
      ? row.host
      : entry.connectionId
        ? null
        : worktreeId
          ? resolveStructuredAgentSessionOwner(state, worktreeId)
          : null
    if (
      runtime &&
      host === (producerByContext.get(runtime) ?? LOCAL_EXECUTION_HOST_ID) &&
      runtime.taskId === entry.orchestration.taskId &&
      runtime.dispatchId === entry.orchestration.dispatchId
    ) {
      return
    }
    if (
      entry.orchestration.parentPaneKey &&
      visibleKey(entry.orchestration.parentPaneKey, host) !== entry.orchestration.parentPaneKey
    ) {
      adapt(entry.paneKey, entry.orchestration, host)
    }
  }
  for (const entry of Object.values(state.agentStatusByPaneKey ?? EMPTY)) {
    embedded(entry)
  }
  for (const retained of Object.values(state.retainedAgentsByPaneKey ?? EMPTY)) {
    embedded(retained.entry, retained.worktreeId)
  }
  const previous = cache?.contexts
  const equal =
    previous &&
    Object.keys(previous).length === Object.keys(contexts).length &&
    Object.keys(contexts).every((key) => previous[key] === contexts[key])
  cache = { inputs, contexts: equal ? previous : contexts }
  return cache
}

/** Canonical contexts stay in storage; actual rows and parent aliases are a shared read-only view. */
export function selectVisibleAgentOrchestration(state: VisibleOrchestrationState): Contexts {
  if (!state.unifiedTabsByWorktree) {
    return state.runtimeAgentOrchestrationByPaneKey ?? EMPTY
  }
  return projection(state).contexts
}

/** The same row identity joins graph enrichment and first status paint, without translating stored parents. */
export function canonicalOrchestrationForRow(
  state: VisibleOrchestrationState,
  paneKey: string
): AgentStatusOrchestrationContext | undefined {
  const row = rowIdentities(state).canonical.get(paneKey)
  const context = state.runtimeAgentOrchestrationByPaneKey?.[row?.key ?? paneKey]
  return context &&
    (!row || row.host === (producerByContext.get(context) ?? LOCAL_EXECUTION_HOST_ID))
    ? context
    : undefined
}

export function representedOrchestrationWorktrees(
  state: VisibleOrchestrationState
): ReadonlyMap<string, string> {
  return rowIdentities(state).worktrees
}
