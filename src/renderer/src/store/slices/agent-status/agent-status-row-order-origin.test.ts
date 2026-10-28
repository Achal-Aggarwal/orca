import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../store-test-helpers'
import { buildWorktreeAgentRows } from '@/components/sidebar/worktree-agent-rows'
import { AGENT_STATE_HISTORY_MAX } from '../../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { retainedAgentEntryFromLive } from './agent-status-pane-key-tab-binding'

const pane = makePaneKey('tab-order', '11111111-1111-4111-8111-111111111111')
const quiet = makePaneKey('tab-quiet', '22222222-2222-4222-8222-222222222222')
afterEach(() => vi.useRealTimers())

function fixture(agentType = 'pi') {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const store = createTestStore()
  const write = (at: number, state: 'working' | 'done', session?: string) =>
    store
      .getState()
      .setAgentStatus(
        pane,
        { state, prompt: 'task', agentType },
        undefined,
        { updatedAt: at },
        { worktreeId: 'wt-order' },
        session ? { providerSession: { key: 'session_id', id: session } } : undefined
      )
  const rows = () =>
    buildWorktreeAgentRows({
      tabs: [],
      entries: Object.values(store.getState().agentStatusByPaneKey),
      retained: [],
      now: 1_000_000
    })
  return { store, write, rows }
}

describe('observed agent session row origin', () => {
  it.each(['pi', 'claude', 'codex'])(
    'keeps %s rows ordered after the recent-history cap',
    (agent) => {
      const { store, write, rows } = fixture(agent)
      write(1000, 'working')
      store
        .getState()
        .setAgentStatus(
          quiet,
          { state: 'working', prompt: '', agentType: agent },
          undefined,
          { updatedAt: 2000 },
          { worktreeId: 'wt-order' }
        )
      const before = rows().map((row) => row.paneKey)
      for (let i = 0; i < AGENT_STATE_HISTORY_MAX + 2; i++) {
        write(3000 + i * 1000, i % 2 ? 'working' : 'done')
      }
      expect(store.getState().agentStatusByPaneKey[pane].stateHistory[0].startedAt).toBeGreaterThan(
        2000
      )
      expect(rows().map((row) => row.paneKey)).toEqual(before)
      const entry = store.getState().agentStatusByPaneKey[pane]
      expect(retainedAgentEntryFromLive(store.getState(), 'wt-order', entry, agent).startedAt).toBe(
        1000
      )
    }
  )

  it('distinguishes known replacement from enrichment, omission and turn completion', () => {
    const { store, write, rows } = fixture('claude')
    write(1000, 'working')
    write(2000, 'working', 'A')
    write(3000, 'done', 'A')
    write(4000, 'working', 'A')
    expect(rows()[0].startedAt).toBe(1000)
    write(5000, 'done', 'A')
    write(6000, 'working', 'B')
    expect(rows()[0].startedAt).toBe(6000)
    const epoch = store.getState().agentStatusEpoch
    write(7000, 'working', 'C')
    expect(rows()[0].startedAt).toBe(7000)
    expect(store.getState().agentStatusEpoch).toBeGreaterThan(epoch)
    write(8000, 'working')
    write(7500, 'done', 'D')
    expect(rows()[0].startedAt).toBe(7000)
    store.getState().dropAgentStatus(pane)
    write(9000, 'working', 'E')
    expect(rows()[0].startedAt).toBe(9000)
  })

  it('reuses a retained displayed origin only for an uncontradicted session', () => {
    const { store, write, rows } = fixture('claude')
    write(1000, 'done', 'A')
    const retained = retainedAgentEntryFromLive(
      store.getState(),
      'wt-order',
      store.getState().agentStatusByPaneKey[pane],
      'claude'
    )
    store.setState({ agentStatusByPaneKey: {}, retainedAgentsByPaneKey: { [pane]: retained } })
    write(3000, 'working', 'A')
    expect(rows()[0].startedAt).toBe(1000)
    store.setState({ agentStatusByPaneKey: {}, retainedAgentsByPaneKey: { [pane]: retained } })
    write(5000, 'working', 'B')
    expect(rows()[0].startedAt).toBe(5000)
  })
})
