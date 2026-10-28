import { agentModelCatalogProbeLister } from './agent-model-catalog-lister'
import { prewarmAgentModelCatalog } from './agent-model-catalog-prewarm'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { retainedAgentModelCatalogModels } from './agent-model-catalog-entry'
import {
  onLiveAccount,
  resolveAgentModelCatalogReadRecords
} from './agent-model-catalog-running-account'
import {
  catalogFolder,
  createAgentModelCatalogLiveListingRecorder,
  type AgentModelCatalogRecord
} from './agent-model-catalog-workspace'

import type {
  AgentModelCatalogServiceDeps,
  AgentModelCatalogService
} from './agent-model-catalog-service-contract'
export type { AgentModelCatalogServiceDeps, AgentModelCatalogService }
import { createAgentModelCatalogLookup } from './agent-model-catalog-lookup'
import { resolveAgentModelCatalogReadScope } from './agent-model-catalog-read-scope'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'

/** Keep picker discovery outside session queues and key it to the launched/selected account.
 * Probe unavailability persists until another probe answers, independently of live model listings. */
export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  const lifetime = new AbortController()
  const admission = new PrioritySemaphore(2)
  const sessionKeys = new Map<string, string>()
  // Reads await configured-default recording so they reflect the reporting chat's resolution.
  const recordingDefaults = new Map<string, Promise<void>>()
  const listWith = agentModelCatalogProbeLister(lifetime.signal)
  // Serialize folder-scoped writes across asynchronous folder lookups.
  const liveWrites = new Map<string, Promise<void>>()
  const sessionCatalogKey = async (record: AgentModelCatalogRecord): Promise<string> =>
    agentModelCatalogFingerprintForRecord(
      record,
      await catalogFolder(deps, record.provider, undefined, record)
    )
  const saveLiveListing = createAgentModelCatalogLiveListingRecorder(deps, recordingDefaults)
  const lookup = createAgentModelCatalogLookup(deps, {
    signal: lifetime.signal,
    admission,
    sessionKeys,
    liveWrites,
    recordingDefaults
  })
  const readResolved: AgentModelCatalogService['readResolved'] = async (params, records) => {
    const scope = await resolveAgentModelCatalogReadScope(deps, params, records)
    return scope ? lookup(params, scope) : { origin: 'unknown' }
  }
  return {
    peek(sessionId, verifiedOnly) {
      const key = sessionKeys.get(sessionId)
      const entry = key ? deps.store.get(key) : null
      return entry && (!verifiedOnly || deps.store.verified(entry)) ? entry : null
    },
    providerStarted(started) {
      const record = onLiveAccount(deps, started)
      const key = sessionKeys.get(record.sessionId)
      if (key) {
        deps.store.expireFailure(key)
      }
      if (!deps.listsInChatFolder?.has(record.provider)) {
        deps.store.expireFailure(agentModelCatalogFingerprintForRecord(record))
        return
      }
      void sessionCatalogKey(record)
        .then((fingerprint) => {
          if (deps.getRecord(record.sessionId)?.lease.runtimeFence === record.lease.runtimeFence) {
            deps.store.expireFailure(fingerprint)
          }
        })
        .catch(() => {})
    },
    readResolved,
    resolveReadRecords: (params, account) =>
      resolveAgentModelCatalogReadRecords({ ...deps, ...account }, params),
    async read(params) {
      const records = await resolveAgentModelCatalogReadRecords(deps, params)
      return records ? readResolved(params, records) : { origin: 'unknown' }
    },
    async retainedLiveModelIds(sessionId, listing) {
      const record = deps.getConversation(sessionId)
      const entry =
        record && deps.drivesRecord(record)
          ? deps.store.get(await sessionCatalogKey(onLiveAccount(deps, record)))
          : undefined
      return retainedAgentModelCatalogModels(entry, listing).map((model) => model.id)
    },
    recordLiveListing(sessionId, listing) {
      const stored = deps.getRecord(sessionId)
      if (!stored || !deps.drivesRecord(stored) || independentAgentModelCatalog(stored.provider)) {
        return
      }
      const record = onLiveAccount(deps, stored)
      if (!deps.listsInChatFolder?.has(record.provider)) {
        saveLiveListing(record, listing, agentModelCatalogFingerprintForRecord(record))
        return
      }
      // Serialize reports so a slow folder lookup cannot overwrite a newer listing.
      const writing = (liveWrites.get(sessionId) ?? Promise.resolve())
        .then(async () => {
          const fingerprint = await sessionCatalogKey(record)
          if (deps.getRecord(sessionId)?.lease.runtimeFence === record.lease.runtimeFence) {
            saveLiveListing(record, listing, fingerprint)
          }
        })
        .catch((error: unknown) => {
          console.warn('[agent-model-catalog] could not save a chat model list:', error)
        })
        .finally(() => {
          if (liveWrites.get(sessionId) === writing) {
            liveWrites.delete(sessionId)
          }
        })
      liveWrites.set(sessionId, writing)
    },
    async prewarm() {
      await prewarmAgentModelCatalog(deps, lifetime.signal, (params) => this.read(params), listWith)
    },
    stop() {
      lifetime.abort()
      sessionKeys.clear()
      deps.store.clearPartialAttempts()
    }
  }
}
