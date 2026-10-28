import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../db'
import type { CrewReadDependencies } from './crew-read-model'
import { conversationRecordReader } from '../structured-session-lineage'
import { peekOpenedAgentSessionRecordStore } from '../../agent-session-record-store-slot'
import { isDeepStrictEqual } from 'node:util'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { crewWorkspaceNames } from './crew-workspace-names'
import { sessionCrewChanges, type CrewInvalidation } from './crew-changes'

type CrewRuntimeWatchDependencies = {
  store: RuntimeStore | null
  watchChanges: (wake: (facets: CrewInvalidation) => void) => () => void
  watchTransitions: (wake: () => void) => () => void
  watchClient: (wake: (event: RuntimeClientEvent) => void) => () => void
}

export function watchCrewRuntimeSources(
  deps: CrewRuntimeWatchDependencies,
  wake: (facets: CrewInvalidation) => void
) {
  const hostIds = () => deps.store?.getWorkspaceSessionHostIds?.() ?? (['local'] as const)
  const namesByHost = new Map(
    hostIds().map((hostId) => [
      hostId,
      crewWorkspaceNames(deps.store?.getWorkspaceSession?.(hostId))
    ])
  )
  const disposers = [
    deps.watchChanges(wake),
    sessionCrewChanges.subscribe(wake),
    deps.watchTransitions(() => wake(new Set(['status', 'names']))),
    deps.store?.onWorkspaceSessionWritten?.((hostId) => {
      for (const id of hostId === null ? hostIds() : [hostId]) {
        const next = crewWorkspaceNames(deps.store?.getWorkspaceSession?.(id))
        if (!isDeepStrictEqual(namesByHost.get(id), next)) {
          namesByHost.set(id, next)
          wake(new Set(['names']))
        }
      }
    }) ?? (() => {}),
    deps.store?.onSettingsChanged?.((updates) => {
      if ('tabAutoGenerateTitle' in updates) {
        wake(new Set(['names']))
      }
    }) ?? (() => {}),
    deps.watchClient((event) => {
      if (
        event.type === 'terminalSideEffects' &&
        event.batch.facts.some((fact) => fact.kind === 'title')
      ) {
        wake(new Set(['names']))
      }
    })
  ]
  return () => disposers.forEach((dispose) => dispose())
}

export function readCrewRuntimeInputs(
  runtime: Pick<
    OrcaRuntimeService,
    | 'getTerminalWorktreeIdForHandle'
    | 'getTerminalProcessIncarnation'
    | 'getTerminalHandleForPaneKey'
    | 'getPaneKeyForTerminalHandle'
    | 'getOrchestrationFleetAgentStatusSnapshot'
    | 'orchestrationSenderNames'
  >,
  db: OrchestrationDb | null,
  retainedDbExists: boolean,
  hostKey: string
): CrewReadDependencies {
  const store = peekOpenedAgentSessionRecordStore()
  return {
    db,
    retainedDbExists,
    hostKey,
    records: store ? conversationRecordReader(store) : null,
    processForHandle: (handle) => runtime.getTerminalProcessIncarnation(handle),
    liveHandle: (handle) => runtime.getTerminalWorktreeIdForHandle(handle) !== null,
    handleForPane: (pane) => runtime.getTerminalHandleForPaneKey(pane),
    paneForHandle: (handle) => runtime.getPaneKeyForTerminalHandle(handle),
    name: runtime.orchestrationSenderNames.captureCrewInputs(),
    get statuses() {
      return runtime.getOrchestrationFleetAgentStatusSnapshot()
    }
  }
}
