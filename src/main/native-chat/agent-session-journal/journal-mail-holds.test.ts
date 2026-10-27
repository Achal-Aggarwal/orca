import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  mailTestResources,
  clearedMailRecord
} from '../../runtime/orchestration/mail-handoff.test-fixture'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { encodeAgentSessionRecord } from '../../../shared/agent-session-record-stored-form'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { JournalHostDatabase } from './journal-host-database'
import { AgentSessionJournal } from './journal-store'
import { writeMailHold } from './journal-mail-holds'
import { bootstrapJournalMailBoundary } from './journal-mail-bootstrap'
import { journalMailSourceEligible, type JournalMailSource } from './journal-mail-boundary'
import { nextSendableQueuedCard } from './queued-message-pause'
import { resumeStructuredQueue } from '../agent-session-wire/structured-agent-session-queued-pause'
import { OrchestrationDb, type MessageRow } from '../../runtime/orchestration/db'
import { captureSessionMailAtStop } from '../../runtime/orchestration/session-mail-stop-inventory'
import { mailSourceIncarnation } from '../../runtime/orchestration/db/messages/mail-source-order'
import { structuredMailBody } from '../../runtime/orchestration/structured-mail-source'

const resources = mailTestResources('pr28567-mail-boundary-')
async function harness(fresh = true) {
  const root = resources.directory()
  const database = resources.track(JournalHostDatabase.open(root))
  const record = agentSessionRecordFixture({
    sessionId: testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
  })
  database.db
    .prepare('INSERT INTO agent_session_records VALUES (?, ?)')
    .run(record.sessionId, JSON.stringify(encodeAgentSessionRecord(record)))
  if (fresh) {
    writeMailHold(database.db, record.sessionId, { version: 1, status: 'released' }, true)
  }
  const identity = {
    sessionId: record.sessionId,
    workspaceId: 'workspace',
    hostId: 'host',
    agent: 'codex' as const,
    providerHandle: null
  }
  const open = async () => {
    const journal = resources.track(new AgentSessionJournal({ database, identity }))
    await journal.open()
    return journal
  }
  const journal = await open()
  const path = join(root, 'mail.db')
  const db = resources.track(new OrchestrationDb(path))
  const mailbox = `orca_session_id:${record.sessionId}`
  const message = (subject: string, imported = false) =>
    db.insertMessage({
      from: 'worker',
      to: mailbox,
      subject,
      ...(imported ? { orderingOrigin: 'imported' as const } : {})
    })
  const source = (row: MessageRow): JournalMailSource => ({
    incarnation: mailSourceIncarnation(db.db),
    mailbox,
    members: [{ id: row.id, sequence: row.sequence, origin: row.ordering_origin ?? null }]
  })
  const enqueue = (row: MessageRow, target = journal) =>
    target.queuedMessages.insert({
      messageId: row.id,
      body: structuredMailBody({
        db,
        mailboxHandle: mailbox,
        dispatchId: null,
        message: row,
        senderName: () => null,
        cliCommand: 'orca'
      }),
      mailSource: source(row)
    })
  const stop = (capture = true, receipt?: Parameters<typeof journal.stops.accept>[1]) =>
    journal.stops.accept(
      {
        event: { reason: 'user-stop' },
        fence: 0,
        liveTurnId: () => null,
        ...(capture
          ? {
              captureMail: (id, records, scope) =>
                captureSessionMailAtStop(db, id, records, () => {}, scope)
            }
          : {})
      },
      receipt
    )
  const eligible = (id: string, target = journal) => {
    const card = target.queuedMessages.get(id)
    if (!card) {
      throw new Error('missing queued report')
    }
    return target.queuedMessages.mailEligible(card)
  }
  const pick = (target = journal) =>
    nextSendableQueuedCard(
      target.queuedMessages.pauses(),
      target.queuedMessages.list(),
      new Set(),
      (card) => target.queuedMessages.mailEligible(card)
    )?.messageId
  return {
    root,
    database,
    record,
    identity,
    journal,
    open,
    db,
    path,
    mailbox,
    message,
    source,
    enqueue,
    stop,
    pick,
    eligible
  }
}

it('holds admitted and missed old reports, lets fresh local mail pass personal FIFO, and preserves that boundary through epoch/reopen', async () => {
  const h = await harness()
  await h.journal.queuedMessages.insert({
    messageId: 'personal',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'personal' }] }
  })
  const admitted = h.message('admitted')
  const missed = h.message('missed')
  await h.enqueue(admitted)
  await h.stop()
  await h.enqueue(missed)
  const imported = h.message('delayed imported', true)
  await h.enqueue(imported)
  const fresh = h.message('fresh')
  await h.enqueue(fresh)
  expect(h.pick()).toBe(fresh.id)
  expect(h.journal.queuedMessages.pauses().map((pause) => pause.reason)).toContain('stopped')
  const original = h.journal.mailHoldFacts().key
  await h.journal.appendStopEvent({ reason: 'host-stop' }, 0)
  expect(h.journal.mailHoldFacts().key).toBe(original)
  await h.journal.replaceEpochItems('unreconcilable_prefix', 0, [])
  expect(h.journal.mailHoldFacts().key).toBe(original)
  const reopened = await h.open()
  expect(reopened.mailHoldFacts().key).toBe(original)
  // Context clear keeps ordinary text holds; it never releases source holds.
  expect(h.eligible(missed.id, reopened)).toBe(false)
  expect(h.eligible(fresh.id, reopened)).toBe(true)
  h.database.db
    .prepare(`UPDATE journal_rows SET row_json = json_set(row_json, '$.mailBoundary',
      json('{"status":"malformed"}')) WHERE session_id = ? AND
      json_type(row_json, '$.mailBoundary') IS NOT NULL`)
    .run(h.record.sessionId)
  const salvaged = await h.open()
  expect(salvaged.mailHoldFacts()).toMatchObject({ held: true, ambiguous: true })
  await salvaged.appendQueueResume(0)
  expect(h.eligible(imported.id, salvaged)).toBe(true)
})

it('failed capture and repeated Stops HOLD; personal Stop/Resume never write the compatibility holds relation', async () => {
  const h = await harness()
  h.database.db.exec(
    `CREATE TRIGGER refuse_legacy_hold BEFORE UPDATE ON agent_session_mail_holds BEGIN SELECT RAISE(ABORT, 'obsolete writer'); END`
  )
  await h.stop(false)
  const ambiguous = h.message('ambiguous')
  await h.enqueue(ambiguous)
  expect(h.pick()).toBeUndefined()
  await h.stop()
  const fresh = h.message('after a complete capture')
  await h.enqueue(fresh)
  expect(h.pick()).toBe(fresh.id)
  await h.stop(false)
  expect(h.pick()).toBeUndefined()
  await h.journal.appendQueueResume(0)
  expect(h.pick()).toBe(ambiguous.id)
  await h.journal.stops.accept({
    event: { reason: 'user-stop' },
    fence: 0,
    liveTurnId: () => null,
    captureMailIntent: false
  })
  expect(h.eligible(ambiguous.id)).toBe(true)
  expect(
    h.database.db.prepare('SELECT state_json FROM agent_session_mail_holds').get()?.state_json
  ).toContain('released')
})

it('holds the zero-wait source reservation through host COMMIT, rolls back a failed Stop and releases before publication', async () => {
  const h = await harness()
  h.message('owed')
  const peer = resources.track(new OrchestrationDb(h.path))
  peer.db.pragma('busy_timeout = 0')
  const before = h.journal.cursor()
  const committed = vi.fn()
  await expect(
    h.stop(true, {
      write: () => {
        expect(h.db.db.isTransaction).toBe(true)
        expect(() =>
          peer.insertMessage({ from: 'peer', to: h.mailbox, subject: 'racing' })
        ).toThrow()
        h.database.db.exec('PRAGMA defer_foreign_keys = ON')
        h.database.db.exec(
          'CREATE TABLE bad_fk (parent INTEGER REFERENCES agent_session_mail_holds(intent_order))'
        )
        h.database.db.prepare('INSERT INTO bad_fk VALUES (?)').run(9999)
      },
      committed
    })
  ).rejects.toThrow('FOREIGN KEY constraint failed')
  expect(committed).not.toHaveBeenCalled()
  expect(h.journal.cursor()).toEqual(before)
  expect(h.db.db.isTransaction).toBe(false)
  expect(h.db.db.pragma('busy_timeout', { simple: true })).toBe(5000)
  expect(h.journal.mailHoldFacts().ambiguous).toBe(false)
  peer.insertMessage({ from: 'peer', to: h.mailbox, subject: 'after rollback' })
  h.journal.observeCommits(() => expect(h.db.db.isTransaction).toBe(false))
  await h.stop()
  expect(h.journal.mailHoldFacts()).toMatchObject({ held: true, ambiguous: false })
  await h.journal.appendStopEvent({ reason: 'host-stop' }, 0)
  expect(h.journal.queuedMessages.list()).toHaveLength(0)
  expect(await resumeStructuredQueue(h.journal, 0)).toBe(true)
  expect(h.journal.mailHoldFacts().held).toBe(false)
})

it.each([100, 1000])(
  'captures one indexed high-water cut without reading an unrelated N=%i inventory, with stable reopen and reset identity',
  async (count) => {
    const h = await harness()
    h.db.insertMessages(
      Array.from({ length: count }, (_, index) => ({
        from: 'worker',
        to: 'unrelated',
        subject: String(index)
      }))
    )
    const old = h.message('old')
    const prepare = vi.spyOn(h.db.db, 'prepare')
    await h.stop()
    expect(
      prepare.mock.calls.some(([sql]) => /SELECT id, run_id, to_handle FROM messages/.test(sql))
    ).toBe(false)
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('MAX(sequence)'))).toHaveLength(1)
    prepare.mockRestore()
    const identity = mailSourceIncarnation(h.db.db)
    const peer = resources.track(new OrchestrationDb(h.path))
    expect(mailSourceIncarnation(peer.db)).toBe(identity)
    expect(
      journalMailSourceEligible(h.journal.queuedMessages.displayState().mailBoundary, h.source(old))
    ).toBe(false)
    h.db.resetMessages()
    expect(mailSourceIncarnation(h.db.db)).not.toBe(identity)
    const replacement = h.message('replacement source')
    await h.enqueue(replacement)
    expect(h.pick()).toBeUndefined()
  }
)

it.each([100, 1000])(
  'bootstraps actual encoded legacy lineage N=%i once, conservatively preserving missing/cyclic evidence',
  async (count) => {
    const h = await harness(false)
    const records = Array.from({ length: count }, (_, index) =>
      agentSessionRecordFixture({
        sessionId: testOrcaSessionId(
          `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
        )
      })
    )
    const insert = h.database.db.prepare(
      'INSERT OR REPLACE INTO agent_session_records VALUES (?, ?)'
    )
    insert.run(records[0].sessionId, JSON.stringify(encodeAgentSessionRecord(records[0])))
    writeMailHold(h.database.db, records[0].sessionId, {
      version: 1,
      status: 'held',
      members: ['legacy-A'],
      ambiguous: false,
      releasedThrough: 0
    })
    const root = resources.track(
      new AgentSessionJournal({
        database: h.database,
        identity: { ...h.identity, sessionId: records[0].sessionId }
      })
    )
    await root.open()
    expect(root.mailHoldFacts().scope?.aliases).toHaveLength(1)
    for (let index = 0; index < count; index++) {
      const record =
        index + 1 < count
          ? clearedMailRecord(records[index], records[index + 1].sessionId)
          : records[index]
      insert.run(record.sessionId, JSON.stringify(encodeAgentSessionRecord(record)))
    }
    expect(bootstrapJournalMailBoundary(h.database.db, records[count - 1].sessionId)).toMatchObject(
      {
        status: 'held',
        members: ['legacy-A'],
        ambiguous: false
      }
    )
    await root.appendQueueResume(0)
    expect(bootstrapJournalMailBoundary(h.database.db, records[count - 1].sessionId).status).toBe(
      'released'
    )
    await root.appendStopEvent({ reason: 'user-stop' }, 0)
    const successorId = records[count - 1].sessionId
    const successor = resources.track(
      new AgentSessionJournal({
        database: h.database,
        identity: { ...h.identity, sessionId: successorId }
      })
    )
    await successor.open()
    expect(successor.mailHoldFacts().ambiguous).toBe(true)
    expect(successor.mailHoldFacts().scope?.aliases).toHaveLength(count)
    await successor.appendQueueResume(0)
    expect(bootstrapJournalMailBoundary(h.database.db, successorId).status).toBe('released')
    const current = h.message('later exact C')
    await successor.stops.accept({
      event: { reason: 'user-stop' },
      fence: 0,
      liveTurnId: () => null,
      captureMail: (id, records, scope) =>
        captureSessionMailAtStop(h.db, id, records, () => {}, scope)
    })
    const boundary = bootstrapJournalMailBoundary(h.database.db, successorId)
    expect(boundary).toMatchObject({
      status: 'held',
      ambiguous: false,
      members: [],
      cuts: [{ throughSequence: current.sequence }]
    })
    expect(successor.mailHoldFacts().members.size).toBe(0)
    const broken = clearedMailRecord(
      h.record,
      testOrcaSessionId('99999999-0000-4000-8000-000000000000')
    )
    h.database.db
      .prepare('UPDATE agent_session_records SET record_json = ? WHERE session_id = ?')
      .run(JSON.stringify(encodeAgentSessionRecord(broken)), h.record.sessionId)
    expect(bootstrapJournalMailBoundary(h.database.db, h.record.sessionId)).toMatchObject({
      status: 'held',
      ambiguous: true
    })
    const cycle = clearedMailRecord(h.record, h.record.sessionId)
    h.database.db
      .prepare('UPDATE agent_session_records SET record_json = ? WHERE session_id = ?')
      .run(JSON.stringify(encodeAgentSessionRecord(cycle)), h.record.sessionId)
    expect(bootstrapJournalMailBoundary(h.database.db, h.record.sessionId)).toMatchObject({
      status: 'held',
      ambiguous: true
    })
  }
)
