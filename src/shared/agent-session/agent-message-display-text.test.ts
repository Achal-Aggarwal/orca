import { expect, it, vi } from 'vitest'
import { agentMessageDisplayText } from './agent-message-display-text'
import { readAgentMessageSource } from './agent-session-message-source'
import {
  agentMessageHeading,
  agentMessageSenderLabel,
  agentMessageSenderView,
  agentMessageSenderCanOpen,
  agentMessagePrimarySender,
  agentMessageOverflows,
  agentMessageFoldLabel,
  agentMessageCanCopy
} from './agent-message-presentation'
import { ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX } from '../orca-dispatch-status-prompt'

const task = readAgentMessageSource({
  kind: 'agent',
  senders: [],
  orchestration: { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
})!
it('gates the memo on provenance, keeps images, and derives the heading from every parsed sender', () => {
  const blocks = [
    { type: 'text', text: `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\r\n=== TASK ===\r\n  task  ` },
    { type: 'image-ref', path: '/image.png' }
  ] as const
  expect(agentMessageDisplayText(blocks, task)).toBe('  task  ')
  expect(agentMessageDisplayText(blocks)).toBeUndefined()
  expect(
    agentMessageDisplayText([...blocks, { type: 'tool-result', output: 'not display input' }], task)
  ).toBeUndefined()
  expect(agentMessageDisplayText([...blocks, { type: 'text', text: '' }], task)).toBeUndefined()
  expect(agentMessageHeading(task)).toBe('task')
  const names = {
    localChat: true,
    customLabel: ' Custom ',
    conversationName: 'Conversation',
    snapshotName: 'Snapshot',
    tabLabel: ' Chat ',
    fallback: 'an agent'
  }
  for (const [facts, expected] of [
    [names, 'Custom'],
    [{ ...names, customLabel: ' ' }, 'Conversation'],
    [{ ...names, customLabel: '', conversationName: null }, 'Snapshot'],
    [{ ...names, localChat: false }, 'Snapshot'],
    [{ ...names, localChat: false, snapshotName: null }, 'Chat'],
    [{ ...names, localChat: false, snapshotName: null, tabLabel: '' }, 'an agent']
  ] as const) {
    expect(agentMessageSenderLabel(facts)).toBe(expected)
  }
  const sender = {
    party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
    name: null
  }
  expect(agentMessageSenderCanOpen(sender, true)).toBe(true)
  expect(agentMessageSenderCanOpen(sender, false)).toBe(false)
  expect(
    agentMessageSenderCanOpen(
      { ...sender, party: { ...sender.party, address: 'dispatch:d' } },
      true
    )
  ).toBe(false)
  expect(agentMessagePrimarySender({ ...task, senders: [sender] })).toBe(sender)
  expect(agentMessagePrimarySender(task)).toBeUndefined()
  expect(agentMessageSenderView({ dot: 'permission' }, 'codex')).toEqual({ dot: 'permission' })
  expect(agentMessageSenderView(undefined, 'codex')).toEqual({ agentType: 'codex' })
  expect(agentMessageSenderView(undefined, undefined)).toEqual({ agentType: undefined })
  expect(agentMessageOverflows(73, 24)).toBe(false)
  expect(agentMessageOverflows(74, 24)).toBe(true)
  expect(agentMessageFoldLabel(true)).toBe('expanded')
  expect(agentMessageFoldLabel(false)).toBe('collapsed')
  expect(agentMessageCanCopy('')).toBe(false)
  expect(agentMessageCanCopy(' ')).toBe(true)
  for (const [relations, expected] of [
    [[], 'generic'],
    [['worker'], 'worker'],
    [['coordinator', 'coordinator'], 'coordinator'],
    [['none'], 'generic'],
    [['future'], 'generic'],
    [['worker', 'coordinator'], 'generic'],
    [['worker', 'worker', 'worker', 'future'], 'generic']
  ] as const) {
    const parsed = readAgentMessageSource({
      kind: 'agent',
      orchestration: { message: 'mail-notice', mailbox: 'term_a', dispatchId: null, messages: [] },
      senders: relations.map((relation, i) => ({
        party: { address: `term_${i}`, terminalHandle: `term_${i}`, orcaSessionId: null },
        name: 'Sender',
        relation
      }))
    })!
    expect(agentMessageHeading(parsed)).toBe(expected)
    expect(parsed.senders).toHaveLength(relations.length)
  }
})
it.each([100, 1000])(
  'bounds actual grammar searches and memoizes immutable blocks at %i tasks',
  (n) => {
    let searched = 0,
      calls = 0
    let recognizing = false
    const original = String.prototype.indexOf
    const search = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      ...args
    ) {
      if (recognizing) {
        calls++
        searched += this.length
      }
      return original.apply(this, args)
    })
    try {
      const raw = `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\n${'instructions '.repeat(500)}\n=== TASK ===\n${'task '.repeat(n * 70)}`
      const inputs = Array.from(
        { length: n },
        () =>
          [
            {
              type: 'text',
              text: raw
            }
          ] as const
      )
      const read = (blocks: Parameters<typeof agentMessageDisplayText>[0]) => {
        recognizing = true
        try {
          return agentMessageDisplayText(blocks, task)
        } finally {
          recognizing = false
        }
      }
      for (const blocks of inputs) {
        expect(read(blocks)).toHaveLength(n * 350)
      }
      expect(calls).toBe(n)
      expect(searched).toBe(n * 24_576)
      const before = { calls, searched }
      for (const blocks of inputs) {
        read(blocks)
      }
      expect({ calls, searched }).toEqual(before)
      for (const blocks of inputs) {
        read([{ type: 'text', text: `${blocks[0].text}edited` }])
      }
      expect(calls).toBe(before.calls * 2)
    } finally {
      search.mockRestore()
    }
  }
)
