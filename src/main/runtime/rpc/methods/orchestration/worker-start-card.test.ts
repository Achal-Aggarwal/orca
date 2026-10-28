import { afterEach, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import { resolveOrchestrationSessionCaller } from '../../orchestration-session-caller'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  hostTestAttachParams,
  hostTestOperationId
} from '../../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { projectStructuredItemsToNativeChat } from '../../../../../shared/structured-agent-session-projection'
import { projectStructuredAgentSessionStatusSummary } from '../../../../../shared/structured-agent-session-projection'
import * as placement from './worker/worker-start-agent-placement'
import * as topology from './worker/worker-topology'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../shared/protocol-version'

const h = createOrchestrationRpcHarness()
const COORD = testOrcaSessionId('start-card-caller')
const WORKER = testOrcaSessionId('start-card-worker')
let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = undefined
  h.cleanup()
  vi.restoreAllMocks()
})

it.each([
  'success',
  'failure',
  'readiness-failure',
  'append-throws',
  'append-pending',
  'reuse',
  'dispatch',
  'context-only',
  'cleared-context',
  'federated',
  'federated-unknown'
] as const)(
  'real worker-start records creation independently of launch: %s',
  async (scenario) => {
    rig = await createQueuedMessageTestRig({ sessionId: WORKER })
    const current = rig
    if (scenario === 'readiness-failure') {
      current.dispatch.mockRejectedValueOnce(new Error('provider dispatch failed'))
    }
    const federated = scenario === 'federated' || scenario === 'federated-unknown'
    setStructuredAgentSessionHost(current.host)
    expect(
      await current.host.attach(
        QUEUED_RIG_CALLER,
        hostTestAttachParams(null, {
          envelope: {
            sessionId: COORD,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: null,
            payloadFingerprint: ''
          }
        })
      )
    ).toMatchObject({ ok: true })
    const { runtime, db } = h.setup(false)
    if (federated) {
      vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
        environmentId: 'remote',
        name: 'remote',
        peerFingerprint: 'peer',
        pairingRevision: 1
      })
      vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
      vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
        async (_host, method, params) => {
          if (method === 'status.get') {
            return {
              capabilities: [
                ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
                ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
              ]
            }
          }
          if (!params || typeof params !== 'object' || !('dispatchId' in params)) {
            throw new Error('missing remote dispatch')
          }
          return {
            dispatchId: params.dispatchId,
            state: scenario === 'federated' ? 'ready' : 'outcome_unknown',
            runtimeEpoch: 'remote-epoch',
            worktreeId: 'remote-workspace',
            terminalHandle: 'term_remote'
          }
        }
      )
    }
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    type WorkspaceLookup = {
      showManagedTerminalWorkspace: (
        ...args: Parameters<typeof runtime.showManagedTerminalWorkspace>
      ) => Promise<placement.WorkerAgentPlacement['worktree']>
    }
    vi.spyOn<WorkspaceLookup, 'showManagedTerminalWorkspace'>(
      runtime,
      'showManagedTerminalWorkspace'
    ).mockResolvedValue({ id: 'workspace-1', repoId: 'repo' })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      runtimeId: runtime.getRuntimeId(),
      terminalHandle: 'term_worker',
      ptyId: 'pty',
      worktreeId: 'workspace-1',
      paneKey: 'tab:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'fixture:1',
      launchTokenHash: null,
      hostScope: { kind: 'local', hostId: 'local' }
    })
    vi.spyOn(topology, 'monitorWorkerSetup').mockImplementation(() => {})
    vi.spyOn(placement, 'placeWorkerAgent').mockImplementation(async (args) => {
      if (scenario === 'failure') {
        throw new Error('placement failed')
      }
      return {
        mode: args.mode,
        worktree: { id: 'workspace-1', repoId: 'repo' },
        terminalHandle: 'term_worker',
        structuredSession: {
          host: current.host,
          identity: {
            sessionId: WORKER,
            handle: 'term_worker',
            agent: args.agent ?? null,
            paneKey: 'tab:11111111-1111-4111-8111-111111111111',
            processIncarnation: 'fixture:1',
            worktreeId: 'workspace-1',
            hostScope: { kind: 'local', hostId: 'local' }
          },
          fence: current.store.requireWritableRecord(WORKER).lease.runtimeFence
        },
        setupReceipt: placement.EXISTING_WORKTREE_SETUP
      }
    })
    const run = db.createRun({
      objective: 'cards',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: COORD
    })
    const append = vi.spyOn(current.host, 'appendAgentStart')
    const pending = Promise.withResolvers<void>()
    if (scenario === 'append-throws') {
      append.mockRejectedValueOnce(new Error('journal unavailable'))
    } else if (scenario === 'append-pending') {
      append.mockReturnValueOnce(pending.promise)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const task = `  Full task 🐋\r\n${'task content\n'.repeat(9000)}END  `
    const dispatch = scenario === 'dispatch' || scenario === 'context-only'
    const method = dispatch ? 'orchestration.dispatch' : 'orchestration.workerStart'
    const admitted = await resolveOrchestrationSessionCaller(
      runtime,
      {
        id: 'start-card',
        authToken: 'test-token',
        method,
        params: dispatch
          ? {
              task: db.createTask({ runId: run.id, spec: task }).id,
              to: `orca_session_id:${WORKER}`,
              inject: scenario === 'dispatch',
              returnPreamble: true
            }
          : {
              spec: task,
              agent: 'codex',
              timeoutMs: 1000,
              ...(federated ? { on: 'remote', worktree: 'id:remote-workspace' } : {}),
              ...(scenario === 'reuse' ? { terminal: `orca_session_id:${WORKER}` } : {})
            },
        orchestrationCompatibilityEvidence: { agentSessionId: COORD }
      },
      undefined
    )
    const before = await current.host.journalSnapshot(COORD)
    const rpc = h.findMethod(method)
    const running = rpc.handler(rpc.params?.parse(admitted.request.params), {
      runtime,
      orchestrationCaller: admitted.caller,
      orchestrationCompatibilityEvidence: admitted.request.orchestrationCompatibilityEvidence,
      ...(federated
        ? {
            orchestrationMutation: {
              callerFingerprint: 'caller',
              requestId: 'start-request',
              method,
              payloadHash: 'payload'
            }
          }
        : {})
    })
    if (scenario !== 'failure' && scenario !== 'context-only' && !federated) {
      await eventually(() => expect(current.dispatch).toHaveBeenCalled())
      expect(append).not.toHaveBeenCalled()
      if (scenario === 'cleared-context') {
        const getConversation = current.store.getConversation
        vi.spyOn(current.store, 'getConversation').mockImplementation((id) => {
          const record = getConversation(id)
          return record && id === COORD
            ? {
                ...record,
                providerContextBoundary: {
                  operationId: 'later-clear',
                  afterFence: record.currentFence,
                  clearedAt: Date.now()
                }
              }
            : record
        })
      }
      if (scenario !== 'readiness-failure') {
        await current.settleAccepted(current.dispatch.mock.calls[0][0].clientMessageId, 'task-turn')
      }
    }
    const result = await running
    if (scenario === 'readiness-failure') {
      expect(result).not.toMatchObject({ state: 'ready' })
    } else if (!dispatch) {
      expect(result).toMatchObject({
        state:
          scenario === 'failure'
            ? 'failed'
            : scenario === 'federated-unknown'
              ? 'outcome_unknown'
              : 'ready'
      })
    }
    // A pending display append must not hold the successful RPC; release it only after the reply.
    if (scenario === 'append-pending') {
      expect(append).toHaveBeenCalledTimes(1)
      pending.resolve()
    }
    if (scenario === 'append-throws') {
      await eventually(() =>
        expect(warn).toHaveBeenCalledWith(
          '[orchestration] recording a started worker in its caller chat failed',
          expect.any(Error)
        )
      )
    }
    if (scenario === 'success' || scenario === 'federated') {
      await eventually(async () =>
        expect(
          (await current.host.journalSnapshot(COORD)).items.some(
            (item) => item.body.kind === 'agent-start'
          )
        ).toBe(true)
      )
    }
    const snapshot = await current.host.journalSnapshot(COORD)
    const cards = snapshot.items.filter((item) => item.body.kind === 'agent-start')
    if (scenario !== 'success' && scenario !== 'federated') {
      expect(cards).toHaveLength(0)
      return
    }
    expect(cards).toHaveLength(1)
    const [card] = cards
    expect(card.body).toMatchObject({
      kind: 'agent-start',
      task,
      ...(!federated
        ? { worker: { party: { address: 'term_worker', terminalHandle: 'term_worker' } } }
        : {})
    })
    if (card.body.kind !== 'agent-start') {
      throw new Error('missing start body')
    }
    if (federated) {
      expect(card.body.worker.party.address).toBe(`dispatch:${card.body.dispatchId}`)
    }
    const destination = append.mock.calls[0][0]
    await Promise.all([
      current.host.appendAgentStart(
        destination,
        { ...card.body, task: 'replayed task' },
        card.observedAt + 10
      ),
      current.host.appendAgentStart(destination, card.body, card.observedAt + 20)
    ])
    expect(
      (await current.host.journalSnapshot(COORD)).items.filter(
        (item) => item.body.kind === 'agent-start'
      )
    ).toEqual(cards)
    expect(projectStructuredItemsToNativeChat(cards)[0]).toMatchObject({
      role: 'system',
      agentStart: true,
      timestamp: card.observedAt,
      blocks: [{ type: 'text', text: task }]
    })
    expect(
      projectStructuredAgentSessionStatusSummary(snapshot.items, snapshot.submissions)
    ).toEqual(projectStructuredAgentSessionStatusSummary(before.items, before.submissions))
    // Full task survives removal of the orchestration rows it came from.
    db.resetAll()
    expect(
      (await current.host.journalSnapshot(COORD)).items.find((item) => item.itemId === card.itemId)
    ).toEqual(card)
    const journal = current.host.collaboratorsForTests().sessions.get(COORD)!.journal
    await journal.appendTombstone(
      { provider: 'orca', clientMessageId: `agent-start:${card.body.dispatchId}` },
      { fence: current.store.getConversation(COORD)!.currentFence }
    )
    await current.host.appendAgentStart(destination, card.body, card.observedAt + 30)
    expect(
      (await current.host.journalSnapshot(COORD)).items.some((item) => item.itemId === card.itemId)
    ).toBe(false)
  },
  20_000
)
