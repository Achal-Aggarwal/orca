import { expect, vi } from 'vitest'
import { useAppStore } from '@/store'
import { registerSessionTabIpcBridge } from '@/hooks/ipc-events/session-tab-ipc-bridge'
import { readStructuredAgentLaunchRecord } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { clearWebSessionFocusIntent } from '@/runtime/web-session-focus-intent'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { runLegacyCliChatResume as runCliChatResume } from './cli-chat-resume-run'
import { snapshot } from './cli-chat-resume-snapshot.test-fixture'
import type { CliChatResumeSource } from './cli-chat-resume-source'
import type { CliChatResumeTestMocks } from './cli-chat-resume-mocks.test-fixture'
import type { AppState } from '@/store/types'

export async function verifyCliChatResumeSlotOrder(
  {
    mocks,
    redrawFromMain,
    seedTabs,
    deferred,
    source: initialSource
  }: {
    mocks: CliChatResumeTestMocks
    redrawFromMain: () => Promise<void>
    seedTabs: () => Promise<AppState['unifiedTabsByWorktree'][string]>
    deferred: <T>() => { promise: Promise<T>; resolve: (value: T) => void }
    source: CliChatResumeSource
  },
  {
    first,
    mover,
    requested,
    expected
  }: {
    first: string
    mover: string
    requested: string
    expected: string
  }
): Promise<void> {
  const tabs = () => useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []
  const [e, source, browser] = await seedTabs()
  let move: Parameters<typeof window.api.ui.onMoveSessionTab>[0] = () => {}
  vi.stubGlobal('api', {
    ...window.api,
    ui: {
      ...window.api?.ui,
      onCloseSessionTab: () => () => {},
      onSessionTabCloseRequest: () => () => {},
      onMoveSessionTab: (callback: typeof move) => {
        move = callback
        return () => {}
      }
    }
  })
  registerSessionTabIpcBridge([])
  const reply = deferred<unknown>()
  mocks.call.mockReturnValue(reply.promise)
  const running = runCliChatResume(initialSource)
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  const sessionId: string = mocks.call.mock.calls[0][2].envelope.sessionId
  const slotId = `structured-agent-session-${sessionId}`
  const store = useAppStore.getState()
  const order = store.groupsByWorktree['wt-1'][0].tabOrder
  expect(order).toEqual([e.id, source.id, browser.id, slotId])
  const later = useAppStore
    .getState()
    .createUnifiedTab('wt-1', 'editor', { id: 'R', entityId: 'R' })
  await redrawFromMain()
  const beforeNoop = useAppStore.getState()
  move({
    kind: 'reorder',
    worktreeId: 'wt-1',
    targetGroupId: e.groupId,
    tabId: browser.id,
    tabOrder: [e.id, source.id, browser.id, later.id]
  })
  expect(useAppStore.getState()).toBe(beforeNoop)
  move({
    kind: 'reorder',
    worktreeId: 'wt-1',
    targetGroupId: e.groupId,
    tabId: mover,
    tabOrder: requested.split(' ')
  })
  const expectedOrder = expected.split(' ').map((id) => (id === 'D' ? slotId : id))
  expect(useAppStore.getState().groupsByWorktree['wt-1'][0].tabOrder).toEqual(expectedOrder)
  expect(readStructuredAgentLaunchRecord(sessionId)?.surfaceAddress).toEqual({
    worktreeId: 'wt-1',
    targetGroupId: e.groupId,
    precedingTabIds: expectedOrder.slice(0, expectedOrder.indexOf(slotId))
  })
  const other = useAppStore.getState().createUnifiedTab('wt-1', 'editor', {
    entityId: 'other',
    split: { splitDirection: 'right', sourceGroupId: e.groupId }
  })
  await redrawFromMain()
  clearWebSessionFocusIntent(structuredAgentSessionFocusOwner({ kind: 'local' }), 'wt-1')
  if (first === 'inventory') {
    applyStructuredSessionTabSnapshots([snapshot(sessionId)])
  }
  reply.resolve({ ok: true, value: { sessionId, fence: 1 } })
  await running
  expect(
    useAppStore.getState().groupsByWorktree['wt-1'].find((group) => group.id === e.groupId)
      ?.tabOrder
  ).toEqual(expectedOrder)
  expect(useAppStore.getState().activeGroupIdByWorktree['wt-1']).toBe(other.groupId)
  useAppStore.getState().moveUnifiedTabToGroup(slotId, other.groupId)
  applyStructuredSessionTabSnapshots([{ ...snapshot(sessionId), snapshotVersion: Date.now() + 1 }])
  expect(tabs().find((tab) => tab.entityId === sessionId)?.groupId).toBe(other.groupId)
}
