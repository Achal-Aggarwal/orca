import '../../rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION } from '../../../../shared/protocol-version'
import { dispatch } from '../../../../cli/dispatch'
import { RuntimeClient, RuntimeClientError } from '../../../../cli/runtime-client'
import { buildCrewSnapshot } from './crew-read-model'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  sessionRecord,
  SESSION_X,
  SESSION_Y,
  WORKER_HANDLE,
  WORKER_PANE
} from '../../rpc/orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('executes snapshot addresses through CLI send and the dispatcher into the proven mailbox', async () => {
  const h = createSessionCallerHarness(hostRef)
  try {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(h.runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    vi.spyOn(h.runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    vi.spyOn(h.runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_peer'
        ? 'tab_peer:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        : handle === 'term_coord'
          ? 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          : handle === WORKER_HANDLE
            ? WORKER_PANE
            : null
    )
    vi.spyOn(h.runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      h.runtime.getTerminalPaneKey(handle)
    )
    const run = h.db.createRun({
      objective: 'Crew',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const worker = h.db.createDispatchContext({
      taskId: h.db.createTask({ runId: run.id, spec: 'Worker' }).id,
      assigneeHandle: WORKER_HANDLE,
      assigneePaneKey: WORKER_PANE,
      creator: { kind: 'system' },
      maxDepth: 10
    })
    const federated = h.db.createStartingWorkerDispatch({
      taskSpec: 'Federated worker',
      taskRunId: run.id,
      creator: { kind: 'system' },
      maxDepth: 10,
      startOptions: { agent: 'codex' },
      federation: {
        environmentId: 'other-host',
        environmentName: 'Windows',
        peerFingerprint: 'test-peer',
        protocolVersion: ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
      }
    })
    h.db.prepareStartingWorkerAuthority({
      dispatchId: federated.dispatch.id,
      handle: 'term_remote',
      paneKey: 'tab_remote:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'runtime:remote:1',
      worktreeId: 'folder-remote',
      effects: [],
      setupState: 'not_applicable'
    })
    h.db.markWorkerDispatchReady(federated.dispatch.id)
    h.db.insertMessage({ from: 'term_peer', to: 'term_coord', subject: 'Hello', body: 'hello' })
    const x = sessionRecord(SESSION_X)
    h.records.set(SESSION_X, {
      ...x,
      conversationCommand: {
        command: 'clear',
        phase: 'committed',
        state: 'completed',
        callerKey: 'clear-key',
        operationId: 'clear-test',
        replacementSessionId: SESSION_Y
      }
    })
    h.records.set(SESSION_Y, sessionRecord(SESSION_Y))
    h.db.insertMessage({
      from: `orca_session_id:${SESSION_X}`,
      to: 'term_coord',
      subject: 'Chat',
      body: 'clear lineage'
    })
    const deps = {
      db: h.db,
      retainedDbExists: true,
      hostKey: 'local',
      statuses: [],
      records: {
        getRecord: (id: string) => {
          const record = h.records.get(id)
          return record ? agentSessionConversationView(record) : null
        },
        listRecords: () => [...h.records.values()].map(agentSessionConversationView)
      },
      liveHandle: (handle: string) => handle.startsWith('term_'),
      paneForHandle: (handle: string) => (handle === WORKER_HANDLE ? WORKER_PANE : null),
      handleForPane: () => null,
      name: () => 'Duplicate name'
    }
    const crew = buildCrewSnapshot('term_coord', deps)
    const managed = buildCrewSnapshot(WORKER_HANDLE, deps)
    const addresses = [
      ...crew.sections.managing,
      ...crew.sections.talkingWith,
      ...managed.sections.managedBy
    ].flatMap((row) => (row.sendAddress ? [row.sendAddress] : []))
    expect(addresses).toEqual(
      expect.arrayContaining([
        `dispatch:${worker.id}`,
        `dispatch:${federated.dispatch.id}`,
        `run:${run.id}`,
        'term_peer',
        `orca_session_id:${SESSION_X}`
      ])
    )
    const client = new RuntimeClient('/tmp/crew-address-client', 1000, null, null)
    vi.spyOn(client, 'call').mockImplementation(async <T>(method: string, params: unknown) => {
      const response = await h.dispatch(
        orchestrationRequest(method, z.record(z.string(), z.unknown()).parse(params))
      )
      if (!response.ok) {
        throw new RuntimeClientError(response.error.code, response.error.message)
      }
      // SAFETY: the real dispatcher validates each method's result; this is only the in-memory transport boundary.
      return { ...response, result: response.result as T, _meta: { runtimeId: 'crew-test' } }
    })
    for (const to of addresses) {
      await dispatch(['orchestration', 'send'], {
        client,
        flags: new Map([
          ['from', WORKER_HANDLE],
          ['to', to],
          ['subject', 'Crew send'],
          ['body', to]
        ]),
        cwd: '/tmp',
        json: true
      })
    }
    const messages = h.db.db
      .prepare("SELECT to_handle, body FROM messages WHERE subject = 'Crew send' ORDER BY sequence")
      .all()
    expect(messages).toEqual(
      addresses
        .filter((address) => address !== `dispatch:${federated.dispatch.id}`)
        .map((address) => ({ to_handle: address, body: address }))
    )
    const relays = h.db.db
      .prepare(
        "SELECT dispatch_id, direction, payload FROM federation_relay_items WHERE kind = 'control_message'"
      )
      .all()
    expect(relays).toEqual([
      expect.objectContaining({
        dispatch_id: federated.dispatch.id,
        direction: 'to_worker',
        payload: expect.stringContaining(`dispatch:${federated.dispatch.id}`)
      })
    ])
  } finally {
    h.close()
  }
})
