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
import { automationRunOperationId } from './automation-run-operation'

const mocks = vi.hoisted(() => ({ host: { journalSnapshot: vi.fn(), subscribe: vi.fn() } }))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => mocks.host
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
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())
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
