import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalSnapshot,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { chatAutomationRunObservation, observeAutomationChatRun } from './runtime-chat-run-observer'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  createQueuedMessageTestRig,
  eventually
} from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { automationRunOperationId } from './automation-run-operation'

const mocks = vi.hoisted(() => ({
  actualHost: null as StructuredAgentSessionHost | null,
  host: { journalSnapshot: vi.fn(), subscribe: vi.fn(), queuedSendAnswer: vi.fn(async () => null) }
}))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => mocks.actualHost ?? mocks.host
}))
const submission: AgentJournalSubmission = {
  clientMessageId: 'prompt',
  fence: 1,
  payloadFingerprint: 'hash',
  dispatchState: 'accepted',
  providerItemId: 'provider-user',
  reason: null,
  submittedAt: 1,
  resolvedAt: 2
}
function turn(
  itemId: string,
  userItemId: string,
  state: 'running' | 'completed' | 'interrupted' = 'completed'
): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'turn',
      turnId: itemId,
      userItemId,
      state,
      ...(state === 'completed' ? { outcome: 'success' as const } : {})
    }
  }
}
function answer(itemId: string, turnItemId: string, text: string): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    sequence: 2,
    observedAt: 2,
    turnScope: { kind: 'turn', turnItemId },
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}
function snapshot(items: AgentJournalRenderItem[] = []): AgentJournalSnapshot {
  return {
    sessionId: 'claude_chat',
    cursor: { epoch: 'epoch', sequence: 2 },
    items,
    submissions: [submission]
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.actualHost = null
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
describe('exact automation chat turn', () => {
  it('waits for its own prompt even when a later human turn completed', () => {
    expect(
      chatAutomationRunObservation(
        snapshot([turn('own', 'provider-user', 'running'), turn('human', 'other')]),
        'prompt',
        'Claude'
      )
    ).toBeNull()
    expect(
      chatAutomationRunObservation(snapshot([turn('human', 'other')]), 'prompt', 'Claude')
    ).toBeNull()
  })
  it('matches the Orca opener alias and snapshots only the accepted root turn', () => {
    const result = chatAutomationRunObservation(
      snapshot([
        turn('own', agentJournalSubmissionKey('prompt')),
        answer('a', 'own', 'Automation output'),
        answer('b', 'human', 'Private later output'),
        { ...answer('c', 'own', 'Child output'), agentId: 'child' }
      ]),
      'prompt',
      'Codex'
    )
    expect(result).toMatchObject({
      status: 'completed',
      error: null,
      outputSnapshot: { content: 'Automation output' }
    })
  })
  it('accepts explicit start proof and never claims a steered or unlinked turn', () => {
    const view = snapshot([turn('own', 'different')])
    view.submissions = [{ ...submission, answeredInTurn: { turnItemId: 'own', via: 'steer' } }]
    expect(chatAutomationRunObservation(view, 'prompt', 'Codex')).toBeNull()
    view.submissions = [{ ...submission, answeredInTurn: { turnItemId: 'own', via: 'start' } }]
    expect(chatAutomationRunObservation(view, 'prompt', 'Codex')?.status).toBe('completed')
  })
  it('reports Stop as Interrupted and unknown or refused prompts as failures', () => {
    expect(
      chatAutomationRunObservation(
        snapshot([turn('own', 'provider-user', 'interrupted')]),
        'prompt',
        'Claude'
      )
    ).toMatchObject({ status: 'dispatch_failed', error: expect.stringContaining('Interrupted') })
    const view = snapshot()
    view.submissions = [{ ...submission, dispatchState: 'unknown' }]
    expect(chatAutomationRunObservation(view, 'prompt', 'Claude')).toMatchObject({
      status: 'dispatch_failed',
      error: expect.stringContaining('Claude')
    })
  })
  it('does not infer success from completed without an outcome and bounds output', () => {
    const own = turn('own', 'provider-user')
    own.body = { kind: 'turn', turnId: 'own', userItemId: 'provider-user', state: 'completed' }
    const result = chatAutomationRunObservation(
      snapshot([own, answer('a', 'own', 'x'.repeat(300_000))]),
      'prompt',
      'Claude'
    )
    expect(result?.status).toBe('dispatch_failed')
    expect(result?.outputSnapshot?.content.length).toBeLessThanOrEqual(256 * 1024)
    expect(result?.outputSnapshot?.truncated).toBe(true)
  })
})

describe('restart observation and disposal', () => {
  function fixture() {
    const run = {
      ...buildProfileStateCutoverFixture('/fixture').automationRuns[0],
      createdAt: Date.now(),
      dispatchedAt: Date.now(),
      sessionKind: 'chat' as const,
      chatSessionId: 'claude_chat'
    }
    const messageId = automationRunOperationId(run, 'reuse-send')
    const records = {
      getOperationRow: vi.fn((_caller: string, id: string) =>
        id === messageId
          ? { outcome: { status: 'succeeded', sessionId: 'claude_chat' } }
          : undefined
      ),
      getConversation: () => ({
        sessionId: 'claude_chat',
        provider: 'claude',
        location: { workspaceId: 'wt-1' }
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: observation reaches only these two runtime boundaries.
    const runtime = {
      ensureStructuredAgentSessionHost: vi.fn(),
      openAgentSessionRecordStore: async () => records
    } as unknown as OrcaRuntimeService
    const view = snapshot([turn('own', agentJournalSubmissionKey(messageId), 'running')])
    view.submissions = [{ ...submission, clientMessageId: messageId }]
    return { run, records, runtime, view }
  }
  it('subscribes before snapshot, ignores token deltas, and releases a subscription that arrives after abort', async () => {
    const { run, runtime, view } = fixture()
    const release = vi.fn()
    const subscription = Promise.withResolvers<() => void>()
    mocks.host.subscribe.mockReturnValue(subscription.promise)
    mocks.host.journalSnapshot.mockResolvedValue(view)
    const controller = new AbortController()
    const pending = observeAutomationChatRun(runtime, run, controller.signal)
    const rejected = expect(pending).rejects.toThrow('request_aborted')
    await vi.waitFor(() => expect(mocks.host.subscribe).toHaveBeenCalledOnce())
    expect(mocks.host.journalSnapshot).not.toHaveBeenCalled()
    controller.abort()
    await rejected
    subscription.resolve(release)
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  })
  it('reattaches from the persisted receipt without sending, observes completion, and unsubscribes', async () => {
    const { run, runtime, view } = fixture()
    const release = vi.fn()
    mocks.host.subscribe.mockResolvedValue(release)
    mocks.host.journalSnapshot.mockResolvedValue(view)
    const pending = observeAutomationChatRun(runtime, run, new AbortController().signal)
    await vi.waitFor(() => expect(mocks.host.journalSnapshot).toHaveBeenCalledOnce())
    const emit = mocks.host.subscribe.mock.calls[0][0].emit
    emit({ type: 'batch', batch: { submissions: [], items: [answer('delta', 'own', 'token')] } })
    await Promise.resolve()
    expect(mocks.host.journalSnapshot).toHaveBeenCalledOnce()
    view.items[0] = turn('own', view.submissions[0].providerItemId!)
    emit({ type: 'batch', batch: { submissions: [], items: [view.items[0]] } })
    expect(await pending).toMatchObject({ status: 'completed' })
    expect(release).toHaveBeenCalledOnce()
  })
  it('fails promptly when no exact accepted receipt survives', async () => {
    const { run, runtime, records } = fixture()
    records.getOperationRow.mockReturnValue(undefined)
    expect(
      await observeAutomationChatRun(runtime, run, new AbortController().signal)
    ).toMatchObject({ status: 'dispatch_failed', error: expect.stringContaining('confirm') })
    expect(mocks.host.subscribe).not.toHaveBeenCalled()
  })
})

// The provider is scripted; queue ownership, journal, catch-up and publication are real.
describe('real host queue publication and operation bounds', () => {
  it.each([100, 1000])(
    'observes Q→S at %i prior turns without token-triggered history scans',
    async (history) => {
      const rig = await createQueuedMessageTestRig({ restartable: true })
      mocks.actualHost = rig.host
      const controller = new AbortController()
      try {
        const working = await rig.workingSend()
        let sink = rig.providerEvents()
        for (let n = 0; n < history; n++) {
          sink.appendItem(
            { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: `old-${n}`, ordinal: 0 },
            { kind: 'turn', turnId: `old-${n}`, state: 'completed', outcome: 'success' },
            { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
          )
          if (n % 100 === 99) {
            await sink.written?.()
          }
        }
        await sink.written?.()
        const run = {
          ...buildProfileStateCutoverFixture('/fixture').automationRuns[0],
          createdAt: Date.now(),
          dispatchedAt: Date.now(),
          sessionKind: 'chat' as const,
          chatSessionId: HOST_TEST_SESSION
        }
        const q = automationRunOperationId(run, 'reuse-send')
        const body = hostTestMessage('automation behind human backlog')
        const fields = { body, delivery: 'queue-if-active' as const }
        expect(
          await rig.host.send(
            { callerKey: 'client-1' },
            {
              ...fields,
              envelope: rig.envelope(fields, 'agentSession.send', q)
            }
          )
        ).toMatchObject({ ok: true, value: { queued: { messageId: q, state: 'waiting' } } })
        const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
        let projections = 0,
          projectedRows = 0,
          scannedRows = 0
        const materialized = new WeakSet<object>()
        const realPublicRead = journal.publicRead.bind(journal)
        vi.spyOn(journal, 'publicRead').mockImplementation(() => {
          const view = realPublicRead()
          return {
            get normalizationKey() {
              return view.normalizationKey
            },
            get snapshot() {
              const result = view.snapshot
              if (!materialized.has(view)) {
                materialized.add(view)
                projections++
                projectedRows += result.items.length + result.submissions.length
              }
              return result
            }
          }
        })
        const visitItems = journal.visitItems.bind(journal)
        vi.spyOn(journal, 'visitItems').mockImplementation((visit) =>
          visitItems((...args) => {
            scannedRows++
            visit(...args)
          })
        )
        let deltaRows = 0
        const readSince = journal.readSince.bind(journal)
        const deltas = vi.spyOn(journal, 'readSince').mockImplementation((...args) => {
          const value = readSince(...args)
          if (value.ok) {
            deltaRows += value.rows.length
          }
          return value
        })
        const timers = vi.spyOn(globalThis, 'setTimeout'),
          cleared = vi.spyOn(globalThis, 'clearTimeout')
        let visited = 0
        const realSnapshot = journal.snapshot.bind(journal)
        const full = vi.spyOn(journal, 'snapshot').mockImplementation((...args) => {
          const value = realSnapshot(...args)
          visited += value.items.length + value.submissions.length
          return value
        })
        const tokenBurst = async () => {
          for (let n = 0; n < 25; n++) {
            sink.appendItem(
              { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'unrelated', ordinal: 1 },
              {
                kind: 'message',
                role: 'assistant',
                blocks: [{ type: 'text', text: `token-${n}` }]
              },
              { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
            )
            sink.publish()
            await sink.written?.()
            await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
          }
        }
        const deltaBaseline = [deltas.mock.calls.length, deltaRows]
        const beforeBaseline = full.mock.calls.length
        const projectionBaseline = [projections, projectedRows, scannedRows]
        const visitedBeforeBaseline = visited
        await tokenBurst()
        const baselineDeltas = [
          deltas.mock.calls.length - deltaBaseline[0],
          deltaRows - deltaBaseline[1]
        ]
        const baselineSnapshots = full.mock.calls.length - beforeBaseline
        const baselineVisited = visited - visitedBeforeBaseline
        const baselineProjection = [projections, projectedRows, scannedRows].map(
          (v, i) => v - projectionBaseline[i]
        )
        const releases: (() => void)[] = []
        const eventTypes: Record<string, number> = {}
        const latest: unknown[] = []
        const observerReads = vi.spyOn(rig.host, 'journalSnapshot')
        const realSubscribe = rig.host.subscribe.bind(rig.host)
        const subscribe = vi.spyOn(rig.host, 'subscribe').mockImplementation(async (...args) => {
          const input = args[0]
          const release = await realSubscribe({
            ...input,
            emit: (event) => {
              eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1
              if (event.type !== 'end') {
                latest.push(event.type === 'batch' ? event.latestTurn : event.page.latestTurn)
              }
              input.emit(event)
            }
          })
          const wrapped = vi.fn(release)
          releases.push(wrapped)
          return wrapped
        })
        // SAFETY: only receipt acquisition is a transport stand-in; the observer uses the actual host below.
        const runtime = {
          ensureStructuredAgentSessionHost: async () => {},
          openAgentSessionRecordStore: async () => ({
            getOperationRow: (_caller: string, id: string) =>
              id === q
                ? { outcome: { status: 'succeeded', sessionId: HOST_TEST_SESSION } }
                : undefined,
            getConversation: () => ({ provider: 'codex', location: { workspaceId: 'workspace-1' } })
          })
        } as unknown as OrcaRuntimeService
        let pending = observeAutomationChatRun(runtime, run, controller.signal)
        void pending.catch(() => {})
        await eventually(() => expect(subscribe).toHaveBeenCalledOnce())
        await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
        await eventually(() => expect(full.mock.calls.length).toBeGreaterThan(0))
        const beforeTokens = full.mock.calls.length
        const projectionTokens = [projections, projectedRows, scannedRows]
        const tokenDeltas = [deltas.mock.calls.length, deltaRows]
        const readsBeforeTokens = observerReads.mock.calls.length
        const visitedBeforeTokens = visited
        await tokenBurst()
        expect(observerReads.mock.calls.length).toBe(readsBeforeTokens)
        expect(full.mock.calls.length - beforeTokens).toBeLessThanOrEqual(baselineSnapshots)
        expect(visited - visitedBeforeTokens).toBeLessThanOrEqual(baselineVisited)
        expect(
          [projections, projectedRows, scannedRows].map((v, i) => v - projectionTokens[i])
        ).toEqual(baselineProjection)
        // One row per token in ordinary catch-up and one in prompt-cache invalidation.
        expect([deltas.mock.calls.length - tokenDeltas[0], deltaRows - tokenDeltas[1]]).toEqual([
          baselineDeltas[0] + 50,
          baselineDeltas[1] + 50
        ])
        controller.abort()
        await expect(pending).rejects.toThrow('request_aborted')
        expect(releases[0]).toHaveBeenCalledOnce()
        pending = observeAutomationChatRun(runtime, run, new AbortController().signal)
        await eventually(() => expect(subscribe).toHaveBeenCalledTimes(2))
        await rig.settleAccepted(working, 'human')
        sink.appendItem(
          { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-human', ordinal: 1 },
          { kind: 'turn', turnId: 'turn-human', state: 'completed', outcome: 'success' },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
        )
        sink.publish({ lifecycle: true })
        expect(await sink.written?.()).toEqual({ ok: true })
        await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
        await eventually(async () => expect(await rig.handoff(q)).toBeDefined())
        const sent = await rig.handoffId(q)
        expect(sent).not.toBe(q)
        await eventually(() => expect(journal.submission(sent)?.handedOverAt).toBeDefined())
        await rig.settleAccepted(sent, 'automation')
        const accepted = await rig.submission(sent)
        sink = rig.providerEvents()
        const ownId = {
          provider: 'codex' as const,
          threadId: HOST_TEST_THREAD,
          turnId: 'turn-automation',
          ordinal: 1
        }
        sink.appendItem(
          ownId,
          {
            kind: 'turn',
            turnId: 'turn-automation',
            userItemId: accepted!.providerItemId!,
            state: 'completed',
            outcome: 'success'
          },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
        )
        sink.publish({ lifecycle: true })
        expect(await sink.written?.()).toEqual({ ok: true })
        await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
        expect(await pending).toMatchObject({ status: 'completed' })
        expect(rig.dispatch).toHaveBeenCalledTimes(2)
        expect(releases).toHaveLength(2)
        for (const release of releases) {
          expect(release).toHaveBeenCalledOnce()
        }
        expect(latest).toContainEqual(
          expect.objectContaining({
            turn: expect.objectContaining({ turnId: 'turn-automation', state: 'completed' })
          })
        )
        for (const [index, args] of timers.mock.calls.entries()) {
          if (Number(args[1]) > 5 * 60 * 60 * 1000) {
            expect(cleared).toHaveBeenCalledWith(timers.mock.results[index].value)
          }
        }
        // Fixed work includes both hydrations, canonical queue handoff and accepted root completion.
        expect(full.mock.calls.length - 2 * baselineSnapshots).toBe(23)
        expect(visited - 2 * baselineVisited).toBeLessThan((history + 30) * 23)
        process.stdout.write(
          `${JSON.stringify({
            history,
            baselineSnapshots,
            baselineVisited,
            baselineProjection,
            baselineDeltas,
            projections,
            projectedRows,
            scannedRows,
            deltaReads: deltas.mock.calls.length,
            deltaRows,
            observerReads: observerReads.mock.calls.length,
            eventTypes,
            fullSnapshots: full.mock.calls.length,
            visited,
            subscriptions: subscribe.mock.calls.length
          })}\n`
        )
      } finally {
        controller.abort()
        mocks.actualHost = null
        await rig.dispose()
      }
    }
  )
  it.each(['withdraw', 'return'] as const)(
    'settles a queue-only %s without resending',
    async (outcome) => {
      const rig = await createQueuedMessageTestRig()
      mocks.actualHost = rig.host
      try {
        await rig.workingSend()
        const queued = rig.send('queued', 'queue-if-active')
        await queued.result
        const q = queued.id
        const run = {
          ...buildProfileStateCutoverFixture('/fixture').automationRuns[0],
          createdAt: Date.now(),
          chatSessionId: HOST_TEST_SESSION
        }
        // Exercise canonical queue answers directly as well as live publisher observation above.
        expect(
          chatAutomationRunObservation(
            await rig.host.journalSnapshot(HOST_TEST_SESSION),
            q,
            'Codex',
            await rig.host.queuedSendAnswer(HOST_TEST_SESSION, q)
          )
        ).toBeNull()
        await rig.stop()
        expect(
          chatAutomationRunObservation(
            await rig.host.journalSnapshot(HOST_TEST_SESSION),
            q,
            'Codex',
            await rig.host.queuedSendAnswer(HOST_TEST_SESSION, q)
          )
        ).toBeNull()
        if (outcome === 'withdraw') {
          await rig.deleteQueued(q)
        } else {
          await rig.stop()
          await rig.sendNow(q)
          const handoff = await rig.handoffId(q)
          await rig.settleRejected(handoff, 'provider refused')
        }
        expect(
          chatAutomationRunObservation(
            await rig.host.journalSnapshot(HOST_TEST_SESSION),
            q,
            'Codex',
            await rig.host.queuedSendAnswer(HOST_TEST_SESSION, q)
          )
        ).toMatchObject({ status: 'dispatch_failed' })
        expect(run.chatSessionId).toBe(HOST_TEST_SESSION)
      } finally {
        mocks.actualHost = null
        await rig.dispose()
      }
    }
  )
})
