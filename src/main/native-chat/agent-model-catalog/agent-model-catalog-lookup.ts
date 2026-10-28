import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { agentSessionAccountHomePath } from '../../../shared/agent-session-account-home'
import type { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { scopedAgentModelCatalogLister } from './agent-model-catalog-lister'
import {
  agentModelCatalogResultFromEntry,
  type AgentModelCatalogEntry
} from './agent-model-catalog-entry'
import { workspaceKeepsListedDefault } from './agent-model-catalog-workspace'
import type { AgentModelCatalogReadScope } from './agent-model-catalog-read-scope'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import type {
  AgentModelCatalogServiceDeps,
  AgentModelCatalogReadParams
} from './agent-model-catalog-service-contract'

/** Lookup consumes account scope; it cannot acquire a conversation owner. */
export function createAgentModelCatalogLookup(
  deps: Pick<
    AgentModelCatalogServiceDeps,
    | 'store'
    | 'getRecord'
    | 'probes'
    | 'listingNamesConfiguredModel'
    | 'agentReadsProjectModelConfig'
    | 'workspaceMayOverrideDefaultModel'
  >,
  state: {
    signal: AbortSignal
    admission: PrioritySemaphore
    sessionKeys: Map<string, string>
    liveWrites: Map<string, Promise<void>>
    recordingDefaults: Map<string, Promise<void>>
  }
): (
  params: AgentModelCatalogReadParams,
  scope: AgentModelCatalogReadScope
) => Promise<AgentSessionModelCatalogResult> {
  const { signal, admission, sessionKeys, liveWrites, recordingDefaults } = state
  return async (params, scope) => {
    const {
      record,
      scoped,
      savedOnly,
      workspacePath,
      folder,
      probeHome,
      base,
      exact,
      resolved,
      cwd,
      fingerprint
    } = scope
    if (scoped && exact) {
      if (sessionKeys.size >= 256 && !sessionKeys.has(scoped.sessionId)) {
        const oldest = sessionKeys.keys().next().value
        if (oldest !== undefined) {
          sessionKeys.delete(oldest)
        }
      }
      sessionKeys.set(scoped.sessionId, fingerprint)
    }
    const accountHomePath = agentSessionAccountHomePath(probeHome)
    await Promise.all(liveWrites.values())
    await recordingDefaults.get(fingerprint)
    let entry = deps.store.get(fingerprint)
    const probe = deps.probes?.[params.agent]
    const list = scopedAgentModelCatalogLister({
      legacy: params.legacy,
      canList: () => !record || !!deps.getRecord(record.sessionId),
      admission,
      signal,
      resolved,
      probe,
      probeHome,
      workspacePath: cwd ?? folder
    })
    const answer = async (
      listed: AgentModelCatalogEntry | null,
      extra: { listingInProgress?: true } = {}
    ): Promise<AgentSessionModelCatalogResult> => {
      if (
        params.verifiedOnly &&
        (!listed ||
          (independentAgentModelCatalog(params.agent) && (!exact || !deps.store.verified(listed))))
      ) {
        return { origin: 'unknown' }
      }
      const display = listed ?? (exact && !params.verifiedOnly ? deps.store.get(base) : null)
      const independent = independentAgentModelCatalog(params.agent)
      const accountFallback =
        independent &&
        scoped &&
        params.savedOnly &&
        params.workspacePath === null &&
        !params.inSessionWorkspace
      const result = display
        ? agentModelCatalogResultFromEntry(
            display,
            independent &&
              !params.legacyOptionsDisplay &&
              (!deps.store.verified(display) || (!exact && !params.legacy))
              ? false
              : exact && listed !== null && deps.store.verified(listed)
                ? true
                : await workspaceKeepsListedDefault(
                    deps,
                    params.agent,
                    accountFallback ? undefined : workspacePath,
                    accountHomePath
                  ),
            deps.listingNamesConfiguredModel?.has(params.agent) === true,
            !independent || (exact && listed !== null && deps.store.verified(listed))
          )
        : null
      const holdsEverywhere =
        result?.listingNamesConfiguredModel === true &&
        deps.agentReadsProjectModelConfig?.(params.agent) === false
      return {
        ...(result ?? { origin: 'unknown' }),
        ...extra,
        ...(holdsEverywhere ? { defaultHoldsInEveryWorkspace: true as const } : {}),
        ...(result && (folder !== undefined || exact)
          ? { modelsDifferByWorkspace: true as const }
          : {}),
        ...(!params.savedOnly &&
        !params.verifiedOnly &&
        deps.store.isListing(fingerprint) &&
        (independent || !listed)
          ? { listingInProgress: true as const }
          : {}),
        ...(deps.store.failure(fingerprint)?.unavailable
          ? { unavailable: deps.store.failure(fingerprint)?.unavailable }
          : {})
      }
    }
    // Observed process exit suppresses background relaunch; explicit new chats may discover.
    if (
      savedOnly ||
      (scoped && !deps.getRecord(scoped.sessionId)) ||
      (!exact &&
        scoped?.ownerObservation.claimStatus === 'released' &&
        scoped.ownerObservation.deathEvidence)
    ) {
      return answer(entry)
    }
    if (probe && probeHome && !signal.aborted && deps.store.heldReasonDue(fingerprint)) {
      void deps.store.refresh(fingerprint, params.agent, probe, list)
      if (!params.waitForListing) {
        return answer(entry, { listingInProgress: true })
      }
      await deps.store.pendingListing(fingerprint, true, params.legacy)
      return answer(deps.store.get(fingerprint))
    }
    let listing =
      !entry && probeHome ? deps.store.pendingListing(fingerprint, false, params.legacy) : null
    if (probe && probeHome && !signal.aborted) {
      if (entry && deps.store.shouldRefresh(fingerprint)) {
        void deps.store.refresh(fingerprint, params.agent, probe, list)
      } else if (!entry && !listing && deps.store.shouldRefresh(fingerprint)) {
        void deps.store.refresh(fingerprint, params.agent, probe, list)
        listing = deps.store.pendingListing(fingerprint, false, params.legacy)
      }
    }
    if (entry && independentAgentModelCatalog(params.agent) && deps.store.isListing(fingerprint)) {
      if (!params.waitForListing) {
        return answer(entry)
      }
      await deps.store.pendingListing(fingerprint, true, params.legacy)
      return answer(deps.store.get(fingerprint))
    }
    if (!entry) {
      if (!listing) {
        return answer(null)
      }
      if (!params.waitForListing) {
        return answer(null)
      }
      const listed = await listing
      entry = deps.store.get(fingerprint) ?? listed
    }
    return answer(entry)
  }
}
