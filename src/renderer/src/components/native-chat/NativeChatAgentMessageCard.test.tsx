// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { createHash } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openAgentMessageSender } from '@/lib/open-agent-message-sender'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'

vi.mock('@/lib/open-agent-message-sender', () => ({ openAgentMessageSender: vi.fn() }))
vi.mock('./native-chat-agent-message-sender-label', () => ({
  useAgentMessageSenderLabel: (sender: { name: string }) => sender.name,
  unnamedSenderLabel: () => 'an agent'
}))
vi.mock('./native-chat-agent-message-sender-view', () => ({
  useAgentMessageSenderView: () => ({ agentType: 'codex', dot: undefined })
}))
vi.mock('./NativeChatMarkdown', () => ({
  NativeChatMarkdown: ({ content }: { content: string }) => <p>{content}</p>
}))

let height = 48
let resize: () => void
beforeEach(() => {
  height = 48
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height)
  const computedStyle = getComputedStyle
  vi.stubGlobal('getComputedStyle', (element: Element) => {
    const style = computedStyle(element)
    Object.defineProperty(style, 'lineHeight', { value: '24px' })
    return style
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function source(relation?: 'worker' | 'coordinator' | 'none'): AgentMessageSource {
  return {
    kind: 'agent',
    orchestration: {
      message: 'mail-notice',
      mailbox: 'term_recipient',
      dispatchId: null,
      messages: []
    },
    senders: [
      {
        party: { address: 'term_sender', terminalHandle: 'term_sender', orcaSessionId: null },
        name: 'Build cards',
        ...(relation ? { relation } : {})
      }
    ]
  }
}
function card(from = source(), text = 'Short message') {
  const message: NativeChatMessage = {
    id: 'm',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text }],
    from
  }
  return (
    <NativeChatAgentMessageCard
      message={message}
      from={from}
      runtimeContext={{ worktreeId: 'wt-chat', worktreePath: null, target: { kind: 'local' } }}
      allowFileUriLinks={false}
      onRefolded={() => {}}
    />
  )
}

it.each([
  ['worker', 'Update from your worker'],
  ['coordinator', 'Message from'],
  ['none', 'Message from'],
  [undefined, 'Message from']
] as const)('uses the recorded %s relation', (relation, heading) => {
  render(card(source(relation)))
  expect(screen.getByText(heading)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
})

it('keeps mixed senders generic and opens a local sender even without live status', () => {
  const from = source('worker')
  const peer = source('none').senders[0]
  render(
    card({
      ...from,
      senders: [
        ...from.senders,
        { ...peer, party: { ...peer.party, address: 'dispatch:foreign' }, name: 'Remote' }
      ]
    })
  )
  expect(screen.getByText('Message from')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Go to agent' }))
  expect(openAgentMessageSender).toHaveBeenCalledWith(expect.anything(), from.senders[0], 'wt-chat')
  expect(screen.getByText('Remote').closest('button')).toBeNull()
})

it('shows only the task spec and toggles only for measured overflow, including width changes', () => {
  const prefix = 'Worker instructions\n=== TASK ===\n'
  const from: AgentMessageSource = {
    ...source('coordinator'),
    orchestration: {
      message: 'task',
      runId: 'r',
      taskId: 't',
      dispatchId: 'd',
      instructions: {
        length: prefix.length,
        sha256: createHash('sha256').update(prefix).digest('hex')
      }
    }
  }
  render(card(from, prefix + 'Build the cards'))
  expect(screen.getByText('Task from your coordinator')).toBeInTheDocument()
  expect(screen.getByText('Build the cards')).toBeInTheDocument()
  expect(screen.queryByText(/Worker instructions/)).not.toBeInTheDocument()
  act(() => {
    height = 120
    resize()
  })
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
  expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
  expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  act(() => {
    height = 48
    resize()
  })
  expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
})
