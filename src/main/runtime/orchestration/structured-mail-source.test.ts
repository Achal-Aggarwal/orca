import { OrchestrationDb } from './db'
import { describe, expect, it } from 'vitest'
import { structuredMailSource, type MailSourceMessage } from './structured-mail-source'

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'

describe('who delivered mail is from', () => {
  it("names each sender once, without the pane key that would open its mailbox, and each message's own sender", () => {
    // No database: a terminal handle and a session address name their party by themselves.
    const source = structuredMailSource({
      db: null,
      mailboxHandle: 'run:r1',
      dispatchId: null,
      batch: [
        { id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null },
        {
          id: 'm2',
          from_handle: `orca_session_id:${SESSION}`,
          run_id: 'r2',
          type: 'status',
          payload: null
        },
        { id: 'm3', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null }
      ],
      senderName: (party) => (party.terminalHandle === 'term_a' ? 'Build tab' : null)
    })
    expect(source).toEqual({
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
          name: 'Build tab'
        },
        {
          party: {
            address: `orca_session_id:${SESSION}`,
            terminalHandle: null,
            orcaSessionId: SESSION
          },
          name: null
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'run:r1',
        dispatchId: null,
        messages: [
          { messageId: 'm1', runId: 'r1', from: 'term_a' },
          { messageId: 'm2', runId: 'r2', from: `orca_session_id:${SESSION}` },
          { messageId: 'm3', runId: 'r1', from: 'term_a' }
        ]
      }
    })
  })

  it('bounds a snapshot name, and a naming failure costs only the name', () => {
    const named = (senderName: (party: unknown) => string | null) =>
      structuredMailSource({
        db: null,
        mailboxHandle: 'run:r1',
        dispatchId: null,
        batch: [{ id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null }],
        senderName
      }).senders[0]?.name
    expect(named(() => `  Build\n${'x'.repeat(400)}`)).toHaveLength(200)
    expect(named(() => '   ')).toBeNull()
    expect(
      named(() => {
        throw new Error('records unavailable')
      })
    ).toBeNull()
  })
})

it('snapshots direct relations per sender, including mixed mail and completed reports', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'cards',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab:coord'
    })
    const assign = (handle: string, creator: string) =>
      db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: handle }).id,
        assigneeHandle: handle,
        assigneePaneKey: `tab:${handle}`,
        creator: { kind: 'terminal', handle: creator },
        maxDepth: 8
      })
    const worker = assign('term_worker', 'term_coord')
    assign('term_peer', 'term_coord')
    const child = assign('term_child', 'term_worker')
    const mail = (
      recipient: string,
      addresses: string[],
      dispatchId: string | null = null,
      report?: string
    ) =>
      structuredMailSource({
        db,
        mailboxHandle: recipient,
        dispatchId,
        senderName: () => 'Sender',
        batch: addresses.map<MailSourceMessage>((address, i) => ({
          id: `m${i}`,
          from_handle: address,
          run_id: run.id,
          type: report ? 'worker_done' : 'status',
          payload: report ? JSON.stringify({ dispatchId: report }) : null
        }))
      })
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBe('worker')
    expect(mail('term_worker', ['term_coord'], worker.id).senders[0].relation).toBe('coordinator')
    expect(mail('term_worker', ['term_peer'], worker.id).senders[0].relation).toBe('none')
    expect(mail('term_coord', ['term_child']).senders[0].relation).toBe('none')
    expect(mail('term_coord', ['unknown']).senders[0].relation).toBeUndefined()
    expect(mail('term_coord', ['dispatch:foreign']).senders[0].relation).toBeUndefined()
    expect(
      mail('term_worker', ['term_child', 'term_peer'], worker.id).senders.map(
        (sender) => sender.relation
      )
    ).toEqual(['worker', 'none'])
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(child.id)
    expect(mail('term_worker', ['term_child'], worker.id, child.id).senders[0].relation).toBe(
      'worker'
    )
    expect(mail('term_coord', ['term_peer'], null, child.id).senders[0].relation).toBeUndefined()
    db.db
      .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'ssh', targetId: 'elsewhere' }), worker.id)
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBeUndefined()
  } finally {
    db.close()
  }
})
