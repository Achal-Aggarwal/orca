import { expect } from 'vitest'
import type { RpcResponse } from '../core'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { hostTestMessage } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  foundRestTestChat,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/journal-host-database-test-support'

export async function verifyRetiredTextConsumers(
  rig: RestTestRig,
  call: (method: string, params: unknown) => Promise<RpcResponse[]>
): Promise<void> {
  await foundRestTestChat(rig)
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const identity = {
    provider: 'codex',
    threadId: REST_TEST_THREAD,
    turnId: 'turn-1',
    ordinal: 900
  } as const
  const options = { fence: 1, ownerFence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const body = { ...hostTestMessage(''), role: 'assistant' as const }
  await journal.appendItem(identity, body, {
    ...options,
    streamText: { operation: 'start', field: 0, baseLength: 0, suffix: 'saved ' }
  })
  rig.clock.now += 10
  await journal.appendItem(identity, body, {
    ...options,
    streamText: { operation: 'append', field: 0, baseLength: 6, suffix: 'reply' }
  })
  const before = liveTestJournalRows(openTestJournalHostDatabase(rig.root).db, SESSION)
  const delta = before.find((row) => JSON.parse(row.rowJson).kind === 'text-delta')!
  expect(before.some((row) => JSON.parse(row.rowJson).v === 5)).toBe(true)
  await journal.appendItem(
    identity,
    { ...body, blocks: [{ type: 'text', text: 'saved reply' }] },
    options
  )
  expect(
    liveTestJournalRows(openTestJournalHostDatabase(rig.root).db, SESSION).some(
      (row) => row.seq === delta.seq
    )
  ).toBe(false)
  await rig.store.replaceSessionOptions({
    sessionId: SESSION,
    fence: 1,
    options: { model: 'gpt-saved' },
    now: rig.clock.now
  })
  const record = rig.store.getRecord(SESSION)
  await rig.restart()
  setStructuredAgentSessionHost(rig.host)
  rig.adapter.acquire.mockClear()

  const history = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(history.ok).toBe(true)
  const [rpc] = await call('agentSession.history', { sessionId: SESSION, direction: 'tail' })
  expect(rpc).toMatchObject({ ok: true, result: history })
  expect(projectStructuredItemsToNativeChat(history.page.items)).toContainEqual(
    expect.objectContaining({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'saved reply' }]
    })
  )
  expect(history.providerSession).toEqual({ key: 'session_id', id: REST_TEST_THREAD })
  expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
    sessionId: SESSION,
    agent: 'codex',
    workspaceId: record!.location.workspaceId,
    model: 'gpt-saved',
    providerSession: history.providerSession
  })
  const [owner] = await call('agentSession.handoffStatus', { sessionId: SESSION })
  expect(owner).toMatchObject({ ok: true, result: { owner: 'native', phase: 'idle' } })
  expect(rig.store.getRecord(SESSION)?.providerHandleChain).toEqual(record!.providerHandleChain)
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
}
