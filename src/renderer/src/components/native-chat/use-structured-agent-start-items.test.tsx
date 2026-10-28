// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { boundedFrameItem } from '../../../../main/native-chat/agent-session-wire/agent-session-bounded-frame-item'
import { measureHistoryItem } from '../../../../main/native-chat/agent-session-wire/agent-session-history-page-bounds'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { useStructuredAgentStartItems } from './use-structured-agent-start-items'

const read = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsStructuredAgentSessionItemDetail: async () => true,
  readStructuredAgentSessionItem: read
}))
afterEach(() => {
  cleanup()
  read.mockReset()
})

it('hydrates bounded starts from their owner for full display and fences a late reply after switching chats', async () => {
  const task = 'full task\n'.repeat(10_000) + 'END'
  const full: AgentJournalRenderItem = {
    itemId: 'start',
    revision: 1,
    observedAt: 1,
    sequence: 1,
    body: {
      kind: 'agent-start',
      dispatchId: 'd',
      task,
      worker: {
        party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null },
        name: 'Worker'
      }
    }
  }
  const head = boundedFrameItem(measureHistoryItem(full)).item
  expect(head.shortened).toBe(true)
  const items = [head]
  const target = { kind: 'environment', environmentId: 'server' } as const
  const pending = Promise.withResolvers<AgentJournalRenderItem>()
  read.mockReturnValueOnce(pending.promise)
  const hook = renderHook(
    ({ sessionId }) => useStructuredAgentStartItems(items, sessionId, target),
    { initialProps: { sessionId: 'caller' } }
  )
  expect(projectStructuredItemsToNativeChat(hook.result.current)).toEqual([])
  await waitFor(() => expect(read).toHaveBeenCalledWith(target, 'caller', 'start'))
  await act(async () => pending.resolve(full))
  expect(projectStructuredItemsToNativeChat(hook.result.current)[0].blocks).toEqual([
    { type: 'text', text: task }
  ])
  const late = Promise.withResolvers<AgentJournalRenderItem | null>()
  read.mockReturnValueOnce(late.promise)
  hook.rerender({ sessionId: 'other-caller' })
  expect(projectStructuredItemsToNativeChat(hook.result.current)).toEqual([])
  await waitFor(() => expect(read).toHaveBeenCalledWith(target, 'other-caller', 'start'))
  hook.unmount()
  await act(async () => late.resolve(full))
})
