import { rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { REST_TEST_CALLER } from './structured-agent-session-rest-test-rig'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  catalogMutationDeadline as settled,
  disposeCatalogMutationHost
} from './structured-agent-session-catalog-mutation.test-support'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from '../agent-model-catalog/agent-model-catalog-fingerprint'
import { structuredAgentModelCatalogAccountReads } from '../../runtime/structured-agent-model-catalog-wiring'
import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import {
  createReceivingCallerFixture,
  HOME_A,
  HOME_B,
  PARENT
} from './structured-agent-session-receiving-callers.test-support'

function catalog(f: Awaited<ReturnType<typeof createReceivingCallerFixture>>) {
  const store = new AgentModelCatalogStore()
  for (const [home, id] of [
    [HOME_A, 'claude-sonnet-5'],
    [HOME_B, 'claude-opus-5-5[1m]']
  ] as const) {
    store.recordSuccess(
      agentModelCatalogScopeFingerprint(
        agentModelCatalogFingerprint({ agent: 'claude', accountHome: home, wslDistro: null }),
        f.rig.root
      ),
      'claude',
      {
        models: [{ id, label: id, isDefault: true, efforts: [] }],
        origin: 'probe',
        complete: true
      },
      'discovery'
    )
  }
  const probe = vi.fn(async () => {
    throw new Error('saved inventory must not probe')
  })
  const service = createAgentModelCatalogService({
    store,
    getConversation: (id) => f.rig.store.getConversation(id) ?? undefined,
    getRecord: (id) => f.rig.store.getRecord(id) ?? undefined,
    recordWorkspacePath: async () => f.rig.root,
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME_B,
    ...structuredAgentModelCatalogAccountReads(() => f.rig.host),
    probes: { claude: probe },
    agentReadsProjectModelConfig: () => false
  })
  f.rig.host.deps.modelCatalog = service
  const read = () => service.read({ agent: 'claude', sessionId: PARENT, savedOnly: true })
  return {
    service,
    probe,
    read,
    ids: async () => {
      const result = await read()
      expect(result.origin).not.toBe('unknown')
      if (result.origin === 'unknown') {
        throw new Error('catalog unexpectedly unknown')
      }
      return result.models.map((model) => model.id)
    }
  }
}

describe('catalog consumes the constructed host receiving account', () => {
  it('reads A before exact native disposition and B afterward, without the global registry', async () => {
    const f = await createReceivingCallerFixture()
    let service: ReturnType<typeof createAgentModelCatalogService> | undefined
    try {
      await f.found()
      const { started } = await f.coldNative()
      f.selectB()
      setStructuredAgentSessionHost(null)
      const c = catalog(f)
      service = c.service
      f.rig.adapter.acquire.mockClear()
      const all = vi.spyOn(f.rig.store, 'listRecords').mockImplementation(() => {
        throw new Error('global history scan')
      })
      expect(await c.ids()).toEqual(['claude-sonnet-5'])
      expect((await f.rig.host.readOptions(PARENT)).current.model).toBe('claude-sonnet-5')
      expect(f.rig.host.hasSession(PARENT)).toBe(true)
      const session = f.rig.host.collaboratorsForTests().sessions.get(PARENT)
      if (!session) {
        throw new Error('existing journal was not adopted')
      }
      const visits = vi.spyOn(session.journal, 'visitItemsWithLinkage')
      await c.read()
      expect(visits).not.toHaveBeenCalled()
      const db = f.runtime.getOrchestrationDb()
      db.failWorkerStart(started.dispatch.id, 'agent_readiness', 'never constructed a worker')
      expect(await c.ids()).toEqual(['claude-opus-5-5[1m]'])
      expect((await f.rig.host.readOptions(PARENT)).current.model).toBe('claude-opus-5-5[1m]')
      expect(c.probe).not.toHaveBeenCalled()
      expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
      all.mockRestore()
    } finally {
      service?.stop()
      await f.dispose()
    }
  })

  it('a proven absent journal still reads A from actual success and pre-notice work without founding one', async () => {
    const f = await createReceivingCallerFixture()
    let service: ReturnType<typeof createAgentModelCatalogService> | undefined
    try {
      await f.proveWithoutJournal()
      await f.coldNative()
      f.selectB()
      const c = catalog(f)
      service = c.service
      f.rig.adapter.acquire.mockClear()
      expect(await c.ids()).toEqual(['claude-sonnet-5'])
      expect(readJournalSessionEpoch(f.rig.host.deps.journalDatabase.db, PARENT)).toBeNull()
      expect(f.rig.host.hasSession(PARENT)).toBe(false)
      expect(c.probe).not.toHaveBeenCalled()
      expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
    } finally {
      service?.stop()
      await f.dispose()
    }
  })

  it('real prospective read failure answers unknown instead of using B cached facts', async () => {
    const f = await createReceivingCallerFixture()
    let service: ReturnType<typeof createAgentModelCatalogService> | undefined
    try {
      await f.found()
      await f.coldNative()
      f.selectB()
      const c = catalog(f)
      service = c.service
      const db = f.runtime.getOrchestrationDb()
      const prepare = db.db.prepare.bind(db.db)
      vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
        if (sql.includes('SELECT id FROM runs WHERE coordinator_orca_session_id')) {
          throw new Error('native read unavailable')
        }
        return prepare(sql)
      })
      expect(await c.read()).toEqual({ origin: 'unknown' })
      expect(c.probe).not.toHaveBeenCalled()
      expect(f.rig.host.childAccountHome(PARENT)).toBeUndefined()
    } finally {
      service?.stop()
      await f.dispose()
    }
  })

  it('owned permission settlement reads actual A until exact native disposition, then eligible B', async () => {
    const f = await createReceivingCallerFixture()
    let service: ReturnType<typeof createAgentModelCatalogService> | undefined
    try {
      await f.found()
      const { started } = await f.coldNative()
      f.selectB()
      setStructuredAgentSessionHost(null)
      const c = catalog(f)
      service = c.service
      f.rig.adapter.acquire.mockClear()
      const all = vi.spyOn(f.rig.store, 'listRecords').mockImplementation(() => {
        throw new Error('global history scan')
      })
      const pick = async () => {
        const key = 'permissionMode'
        const value = 'own'
        expect(
          await settled(
            f.rig.host.setOption(REST_TEST_CALLER, {
              key,
              value,
              envelope: {
                sessionId: PARENT,
                clientOperationId: hostTestOperationId(),
                expectedRuntimeFence: f.rig.store.requireWritableRecord(PARENT).lease.runtimeFence,
                payloadFingerprint: computeAgentSessionPayloadFingerprint({
                  method: 'agentSession.setOption',
                  sessionId: PARENT,
                  fields: { key, value }
                })
              }
            }),
            'receiving-account permission mutation'
          )
        ).toMatchObject({
          ok: true,
          value: { key, value, options: { permissionMode: 'own' } }
        })
        expect(f.rig.store.requireWritableRecord(PARENT).permissionMode).toBe('own')
        return c.service.peek(PARENT, true)?.models.map((model) => model.id)
      }
      expect(await pick()).toEqual(['claude-sonnet-5'])
      f.runtime
        .getOrchestrationDb()
        .failWorkerStart(started.dispatch.id, 'agent_readiness', 'never constructed a worker')
      expect(await pick()).toEqual(['claude-opus-5-5[1m]'])
      expect(c.probe).not.toHaveBeenCalled()
      expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
      expect(f.rig.adapter.dispatch).not.toHaveBeenCalled()
      expect(f.rig.adapter.readOptions).not.toHaveBeenCalled()
      expect(all).not.toHaveBeenCalled()
    } finally {
      service?.stop()
      await f.dispose(
        () => disposeCatalogMutationHost(f.rig),
        () => rm(f.rig.root, { recursive: true, force: true })
      )
    }
  }, 10_000)
})
