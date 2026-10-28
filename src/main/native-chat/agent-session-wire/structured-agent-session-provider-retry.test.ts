import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CALLER,
  attach,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { structuredAgentSessionCanStop } from '../../../shared/structured-agent-session-stop-control'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexTurnLifecycleIdentity } from '../../codex/codex-structured-journal-translation-turns'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionProviderRetryPending } from './structured-agent-session-provider-retry'

const frames: { case: string; method: string; params: unknown }[] = readFileSync(
  join(__dirname, '../../codex/__fixtures__/codex-app-server-turn-endings.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
afterEach(() => vi.useRealTimers())

async function setup() {
  const { host, dispatch, acquire } = hostTestState()
  dispatch.mockResolvedValue({
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 }
  })
  const continuation = vi.fn(
    async (
      _input: Parameters<NonNullable<typeof host.deps.adapter.continueAfterTransientFailure>>[0]
    ) => ({ state: 'started' as const, providerTurnRef: 'retry-1' })
  )
  host.deps.adapter.continueAfterTransientFailure = continuation
  await attach()
  const body = hostTestMessage('finish the job')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  await vi.waitFor(() =>
    expect(
      host.collaboratorsForTests().sessions.get(SESSION)?.journal.submissions()[0]?.dispatchState
    ).toBe('accepted')
  )
  const sink = acquire.mock.calls.at(-1)![0].events!
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const translator = createCodexJournalTranslator({
    sink,
    sessionId: SESSION,
    primaryThreadId: () => THREAD,
    dispatchRequestOrigin: () => ({
      requestedAt: journal.submissions()[0].submittedAt,
      sequence: 1
    })
  })
  const published: string[] = []
  host.observeJournalPublications(SESSION, () =>
    published.push(host.readStatusSummary(SESSION)?.status ?? 'missing')
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const fail = async () => {
    for (const frame of frames.filter(
      (frame) =>
        frame.case === '0.158.0-stream-drop' &&
        ['turn/started', 'error', 'turn/completed'].includes(frame.method)
    )) {
      const params = JSON.parse(
        JSON.stringify(frame.params)
          .replaceAll('00000000-0000-7000-8000-000000000062', THREAD)
          .replaceAll('00000000-0000-7000-8000-000000000063', 'turn-1')
      )
      translator.handle({
        type: 'notification',
        sessionId: SESSION,
        threadId: THREAD,
        method: frame.method,
        params
      })
      if (frame.method === 'turn/started') {
        // The mocked dispatch's exact echo supplies the opening request's attribution.
        translator.handle({
          type: 'notification',
          sessionId: SESSION,
          threadId: THREAD,
          method: 'item/completed',
          params: {
            threadId: THREAD,
            turnId: 'turn-1',
            item: {
              type: 'userMessage',
              id: 'root-echo',
              clientId: journal.submissions()[0].clientMessageId,
              content: []
            }
          }
        })
      }
    }
    await host.flushStreamedEvents(SESSION)
  }
  const endRetry = async (turnId: string, failure: boolean) => {
    const identity = codexTurnLifecycleIdentity(SESSION, turnId)
    sink.appendItem(
      identity,
      { kind: 'turn', turnId, state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    if (failure) {
      sink.noteTransientFailure!(identity, 'stream-disconnected')
    }
    sink.appendItem(
      identity,
      { kind: 'turn', turnId, state: 'completed', outcome: failure ? 'failure' : 'success' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)
  }
  return { host, journal, continuation, dispatch, fail, endRetry, published }
}

it('keeps a recorded stream drop working, continues without a user item, then completes', async () => {
  const rig = await setup()
  await rig.fail()
  expect(rig.host.currentWork(SESSION)?.working()).toBe(true)
  expect(rig.host.readStatusSummary(SESSION)?.status).toBe('working')
  expect(rig.published).not.toContain('idle')
  const before = rig.journal
    .snapshot()
    .items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
  await vi.advanceTimersByTimeAsync(1_999)
  expect(rig.continuation).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(rig.continuation).toHaveBeenCalledOnce()
  expect(rig.continuation.mock.calls[0]?.[0]).toMatchObject({
    sessionId: SESSION,
    options: rig.journal.submissions()[0].options
  })
  expect(rig.host.readStatusSummary(SESSION)?.status).toBe('working')
  expect(rig.published).not.toContain('idle')
  await rig.endRetry('retry-1', false)
  expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
    status: 'idle',
    turnOutcome: 'success'
  })
  expect(
    rig.journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
  ).toEqual(before)
})

it('Stop during backoff publishes Interrupted and Resume never resurrects the timer', async () => {
  const rig = await setup()
  await rig.fail()
  expect(
    structuredAgentSessionCanStop({
      turnId: null,
      isWorking: rig.host.currentWork(SESSION)!.working(),
      sending: false,
      stopsConversation: true
    })
  ).toBe(true)
  expect(
    await rig.host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
  ).toMatchObject({ ok: true })
  expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
    status: 'idle',
    turnOutcome: 'interruption'
  })
  expect(
    rig.host.currentWork(SESSION)?.publishedLatestTurn({
      itemId: agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, 'turn-1')),
      observedAt: 1,
      turn: { turnId: 'turn-1', state: 'completed', outcome: 'failure' }
    })
  ).toMatchObject({ turn: { state: 'interrupted' } })
  await rig.host.queuedMessagesResume(CALLER, {
    envelope: envelope('agentSession.queuedMessagesResume', {})
  })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(rig.continuation).not.toHaveBeenCalled()
})

it.each(['send', 'queued report'])(
  'delivers a %s immediately during backoff and replaces the retry',
  async (kind) => {
    const rig = await setup()
    await rig.fail()
    const body = hostTestMessage('do this instead')
    if (kind === 'send') {
      const fields = { body, delivery: 'queue-if-active' as const }
      expect(
        await rig.host.send(CALLER, { envelope: envelope('agentSession.send', fields), ...fields })
      ).toMatchObject({ ok: true })
    } else {
      await rig.journal.queuedMessages.insert({
        messageId: 'queued-report',
        body: {
          ...body,
          from: {
            kind: 'agent',
            senders: [],
            orchestration: {
              message: 'mail-notice',
              mailbox: 'agent:worker',
              dispatchId: null,
              messages: []
            }
          }
        }
      })
    }
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.continuation).not.toHaveBeenCalled()
  }
)

it('ends after five continuations with 2/4/8/16/30 second backoff and no added failure note', async () => {
  const rig = await setup()
  await rig.fail()
  const notes = () =>
    rig.journal.snapshot().items.filter((item) => item.body.kind === 'status').length
  const before = notes()
  for (const [index, delay] of [2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
    rig.continuation.mockResolvedValue({ state: 'started', providerTurnRef: `retry-${index + 1}` })
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(rig.continuation).toHaveBeenCalledTimes(index)
    await vi.advanceTimersByTimeAsync(1)
    expect(rig.continuation).toHaveBeenCalledTimes(index + 1)
    await rig.endRetry(`retry-${index + 1}`, true)
  }
  await vi.advanceTimersByTimeAsync(60_000)
  expect(rig.continuation).toHaveBeenCalledTimes(5)
  expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
    status: 'idle',
    turnOutcome: 'failure'
  })
  expect(notes()).toBe(before)
})

it('closing the owner drops a pending retry', async () => {
  const rig = await setup()
  await rig.fail()
  await rig.host.close(SESSION, 'user-close')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(structuredAgentSessionProviderRetryPending(rig.journal)).toBe(false)
  expect(rig.continuation).not.toHaveBeenCalled()
})
