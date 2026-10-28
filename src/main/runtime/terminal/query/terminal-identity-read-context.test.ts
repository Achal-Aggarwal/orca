import { expect, it, vi } from 'vitest'
import '../../orca-runtime-test-mocks.spec'
import { createRuntime, TEST_WORKTREE_ID } from '../../orca-runtime-test-fixtures.spec'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type {
  OrchestrationCompatibilitySshTerminal,
  TerminalHandleRecord
} from '../../runtime-terminal-contracts'
import type { PtyIncarnationHandleRecord } from '../../orca-runtime-core'
import type { CrewChanges } from '../../orchestration/crew/crew-changes'
import type { RuntimeTerminalWaiterRegistry } from '../wait/terminal-waiter-registry'
import type { TerminalIdentityReadContext } from './terminal-identity-read-context'

const LEAF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COLD = 'cold:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PANE = `tab-original:${LEAF}`

type Owner = {
  terminalWaiters: RuntimeTerminalWaiterRegistry
  crewChanges: CrewChanges
  orchestrationCompatibilitySshTerminals: Map<string, OrchestrationCompatibilitySshTerminal>
  getOrchestrationCompatibilitySshTerminal: (
    handle: string,
    context?: TerminalIdentityReadContext
  ) => OrchestrationCompatibilitySshTerminal | undefined
  runtimeId: string
  rendererGraphEpoch: number
  handles: Map<string, TerminalHandleRecord>
  handleByPtyId: Map<string, string>
  handleByLeafKey: Map<string, string>
  handleByPtyIncarnation: Map<string, PtyIncarnationHandleRecord>
  syntheticTerminalHandles: Set<string>
  leaves: Map<string, RuntimeLeafRecord>
  ptysById: Map<string, RuntimePtyWorktreeRecord>
  recordPtyWorktree: (
    id: string,
    worktree: string,
    state?: Partial<RuntimePtyWorktreeRecord>
  ) => RuntimePtyWorktreeRecord
  getLivePtyForHandle: (
    handle: string,
    context?: TerminalIdentityReadContext
  ) => { record: TerminalHandleRecord; pty: RuntimePtyWorktreeRecord } | null
  getPtyRecordForPaneKey: (
    pane: string,
    context?: TerminalIdentityReadContext
  ) => RuntimePtyWorktreeRecord | null
  beginGraphReload: (windowId: number) => number
  findHandleForPtyRecord: (ptyId: string, context?: TerminalIdentityReadContext) => string | null
  issueHandle: (leaf: RuntimeLeafRecord, context?: TerminalIdentityReadContext) => string
  rejectWaitersForHandle: (handle: string, reason: string) => void
}

function fixture() {
  const runtime = createRuntime()
  // SAFETY: this fixture exercises the existing protected map/effect owner with its production shapes.
  const owner = runtime as unknown as Owner
  const rejected = vi.spyOn(owner, 'rejectWaitersForHandle')
  const add = (id: string, handle: string, paneKey = PANE, connected = true) => {
    owner.recordPtyWorktree(id, TEST_WORKTREE_ID, { paneKey, connected })
    owner.handleByPtyId.set(id, handle)
  }
  const stamp = (handle: string, ptyId: string) => {
    owner.handles.set(handle, {
      handle,
      runtimeId: owner.runtimeId,
      rendererGraphEpoch: owner.rendererGraphEpoch,
      worktreeId: TEST_WORKTREE_ID,
      tabId: `pty:${ptyId}`,
      leafId: `pty:${ptyId}`,
      ptyId,
      ptyGeneration: 0
    })
  }
  const state = () => ({
    handles: [...owner.handles].map(([key, record]) => [
      key,
      { ...record, runtimeId: '<runtime>' }
    ]),
    reverse: [...owner.handleByPtyId],
    leaf: [...owner.handleByLeafKey],
    retained: [...owner.handleByPtyIncarnation].map(([key, value]) => [key, { ...value }]),
    synthetic: [...owner.syntheticTerminalHandles],
    rejected: rejected.mock.calls
  })
  return { runtime, owner, add, stamp, state }
}

it('matches separate production runtimes across reverse repair, stale first mapping, adoption and dependent reads in either order', () => {
  for (const reverseOrder of [false, true]) {
    for (const absentFirst of [false, true]) {
      const baseline = fixture()
      const candidate = fixture()
      for (const f of [baseline, candidate]) {
        f.owner.handleByPtyId.set('absent-first', 'term_shared')
        if (!absentFirst) {
          f.add('absent-first', 'term_shared', 'malformed-pane', false)
        }
        f.add('live-second', 'term_shared', 'repaired-second')
        f.add('cold', 'term_cold', COLD)
        f.stamp('term_cold', 'cold')
        f.owner.handleByPtyId.delete('cold')
        f.add('adopted', 'term_adopted', `tab-new:${LEAF}`)
        f.runtime.attachWindow(1)
        f.runtime.syncWindowGraph(1, {
          tabs: [
            {
              tabId: 'tab-new',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Terminal',
              activeLeafId: LEAF,
              layout: null
            }
          ],
          leaves: [
            {
              tabId: 'tab-new',
              worktreeId: TEST_WORKTREE_ID,
              leafId: LEAF,
              paneRuntimeId: 1,
              ptyId: 'adopted'
            }
          ]
        })
        // The production reload writer clears handle records while retaining CLI reverse mappings.
        f.owner.beginGraphReload(1)
        expect(f.owner.handles.has('term_adopted')).toBe(false)
        f.stamp('term_cold', 'cold')
      }
      const context = candidate.runtime.createTerminalIdentityReadContext()
      const read = (f: ReturnType<typeof fixture>, ctx?: TerminalIdentityReadContext) => {
        const actions = [
          () => f.owner.getLivePtyForHandle('term_absent', ctx)?.pty.ptyId ?? null,
          () => f.owner.getLivePtyForHandle('term_shared', ctx)?.pty.ptyId ?? null,
          () => f.runtime.getTerminalHandleForPaneKey('repaired-second', ctx),
          () => f.owner.getLivePtyForHandle('term_shared', ctx)?.pty.ptyId ?? null,
          () => f.owner.getPtyRecordForPaneKey(PANE, ctx)?.ptyId ?? null,
          () => f.runtime.getTerminalHandleForPaneKey(`tab-new:${LEAF}`, ctx),
          () => f.owner.getLivePtyForHandle('term_adopted', ctx)?.pty.ptyId ?? null,
          () => f.runtime.getTerminalHandleForPaneKey('malformed-pane', ctx)
        ]
        if (reverseOrder) {
          actions.reverse()
        }
        const result = actions.map((action) => action())
        // Cold synthetic-record acquisition, then a lookup dependent on the owner's reverse-map write.
        result.push(f.runtime.getTerminalHandleForPaneKey(COLD, ctx))
        result.push(f.owner.getLivePtyForHandle('term_cold', ctx)?.pty.ptyId ?? null)
        return result
      }
      expect(read(candidate, context)).toEqual(read(baseline))
      expect(candidate.state()).toEqual(baseline.state())
    }
  }
})

function countIterations<K, V>(
  map: Map<K, V>,
  counts: { entries: number; get: number; set: number; delete: number }
) {
  for (const method of ['get', 'set', 'delete'] as const) {
    const original = map[method].bind(map)
    Object.defineProperty(map, method, {
      configurable: true,
      value: (...args: Parameters<typeof original>) => {
        counts[method]++
        // SAFETY: this transparent fixture wrapper forwards the exact selected native Map method's arguments.
        return (original as (...input: Parameters<typeof original>) => unknown)(...args)
      }
    })
  }
  for (const method of ['entries', 'keys', 'values', Symbol.iterator] as const) {
    const original = map[method].bind(map)
    Object.defineProperty(map, method, {
      configurable: true,
      value: function* () {
        for (const value of original()) {
          counts.entries++
          yield value
        }
      }
    })
  }
}

it('charges actual native map visits at N/10N for missing, moved and cold identities and leaves fast hits lazy', () => {
  const measure = (population: number, indexed: boolean, fast: boolean) => {
    const f = fixture()
    for (let i = 0; i < population; i++) {
      const pane = `tab-${i}:aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
      f.add(`pty-${i}`, `term_${i}`, pane)
      f.stamp(`term_${i}`, `pty-${i}`)
    }
    const counts = { entries: 0, get: 0, set: 0, delete: 0 }
    countIterations(f.owner.handles, counts)
    countIterations(f.owner.handleByPtyId, counts)
    countIterations(f.owner.leaves, counts)
    countIterations(f.owner.ptysById, counts)
    const context = indexed ? f.runtime.createTerminalIdentityReadContext() : undefined
    for (let i = 0; i < population; i++) {
      f.owner.getLivePtyForHandle(fast ? `term_${i}` : `term_missing_${i}`, context)
      if (!fast) {
        expect(f.owner.getPtyRecordForPaneKey(`missing-${i}:${LEAF}`, context)).toBeNull()
      }
    }
    return counts
  }
  const baseline = [measure(3, false, false), measure(30, false, false)]
  const candidate = [measure(3, true, false), measure(30, true, false)]
  expect(baseline[1].entries).toBe(baseline[0].entries * 100)
  expect(candidate[1].entries).toBe(candidate[0].entries * 10)
  expect(measure(30, true, true).entries).toBe(0)
  const cold = (population: number, indexed: boolean) => {
    const f = fixture()
    for (let i = 0; i < population; i++) {
      f.add(`cold-${i}`, `term_cold_${i}`, `cold-pane-${i}`)
      f.stamp(`term_cold_${i}`, `cold-${i}`)
      f.owner.handleByPtyId.delete(`cold-${i}`)
    }
    const counts = { entries: 0, get: 0, set: 0, delete: 0 }
    countIterations(f.owner.handles, counts)
    countIterations(f.owner.ptysById, counts)
    countIterations(f.owner.handleByPtyId, counts)
    const context = indexed ? f.runtime.createTerminalIdentityReadContext() : undefined
    for (let i = 0; i < population; i++) {
      expect(f.runtime.getTerminalHandleForPaneKey(`cold-pane-${i}`, context)).toBe(
        `term_cold_${i}`
      )
      expect(f.owner.getLivePtyForHandle(`term_cold_${i}`, context)?.pty.ptyId).toBe(`cold-${i}`)
    }
    return counts
  }
  const coldBaseline = [cold(3, false), cold(30, false)]
  const coldCandidate = [cold(3, true), cold(30, true)]
  expect(coldBaseline[1].entries).toBeGreaterThan(coldBaseline[0].entries * 50)
  expect(coldCandidate[1].entries).toBe(coldCandidate[0].entries * 10)
  console.log('cold synthetic native operations', {
    baseline: coldBaseline,
    candidate: coldCandidate
  })
  console.log('terminal acquisition native operations', {
    baseline,
    candidate,
    fast: measure(30, true, true)
  })
})

it('invalidates actual SSH-held facts on register and finally-release with equal and conflicting claims', async () => {
  const f = fixture()
  const wake = vi.fn()
  const stop = f.owner.crewChanges.subscribe(wake)
  const terminal = { handle: 'term_ssh', paneKey: PANE, processIncarnation: 'remote-process' }
  const first = f.runtime.registerOrchestrationCompatibilitySshAttachment('target', 'one', terminal)
  const equal = f.runtime.registerOrchestrationCompatibilitySshAttachment('target', 'two', terminal)
  expect(wake).toHaveBeenCalledTimes(2)
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBe(PANE)
  const ctx = f.runtime.createTerminalIdentityReadContext()
  expect(f.owner.getOrchestrationCompatibilitySshTerminal(terminal.handle, ctx)).toEqual(terminal)
  expect(f.runtime.getTerminalProcessIncarnation(terminal.handle, ctx)).toBe('remote-process')
  const conflict = f.runtime.registerOrchestrationCompatibilitySshAttachment(
    'other-target',
    'three',
    terminal
  )
  try {
    // A changed source owns a fresh finite context; the old context is never retained as authority.
    expect(
      f.owner.getOrchestrationCompatibilitySshTerminal(
        terminal.handle,
        f.runtime.createTerminalIdentityReadContext()
      )
    ).toBeUndefined()
    expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBeNull()
    await Promise.resolve()
  } finally {
    f.runtime.releaseOrchestrationCompatibilitySshAttachment(conflict.attachmentId)
  }
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBe(PANE)
  f.runtime.releaseOrchestrationCompatibilitySshAttachment(first.attachmentId)
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBe(PANE)
  f.runtime.releaseOrchestrationCompatibilitySshAttachment(equal.attachmentId)
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBeNull()
  expect(wake).toHaveBeenCalledTimes(6)
  f.runtime.releaseOrchestrationCompatibilitySshAttachment(equal.attachmentId)
  expect(wake).toHaveBeenCalledTimes(6)
  stop()
})

it('keeps cold candidates coherent through real retained-handle invalidation and waiter rejection', () => {
  const run = (indexed: boolean) => {
    const f = fixture()
    f.add('retained-pty', 'term_retained', PANE)
    f.runtime.attachWindow(1)
    f.runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-original',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: LEAF,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-original',
          worktreeId: TEST_WORKTREE_ID,
          leafId: LEAF,
          paneRuntimeId: 1,
          ptyId: 'retained-pty'
        }
      ]
    })
    const leaf = f.owner.leaves.get(`tab-original::${LEAF}`)!
    f.owner.handleByLeafKey.clear()
    f.owner.handleByPtyId.clear()
    f.stamp('term_retained', 'retained-pty')
    f.owner.syntheticTerminalHandles.add('term_retained')
    f.owner.handleByPtyIncarnation.set('retained-pty', {
      handle: 'term_retained',
      incarnationId: 'old-process',
      leafKey: `tab-original::${LEAF}`
    })
    const context = indexed ? f.runtime.createTerminalIdentityReadContext() : undefined
    expect(f.owner.findHandleForPtyRecord('retained-pty', context)).toBe('term_retained')
    const waiterRejected = vi.fn()
    f.owner.terminalWaiters.add({
      handle: 'term_retained',
      condition: 'exit',
      resolve: vi.fn(),
      reject: waiterRejected,
      timeout: null,
      cancelIdlePoll: null,
      abortCleanup: null
    })
    const handle = f.owner.issueHandle(leaf, context)
    expect(waiterRejected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'terminal_handle_stale' })
    )
    expect(f.owner.terminalWaiters.get('term_retained')).toBeUndefined()
    expect(handle).not.toBe('term_retained')
    expect(f.owner.findHandleForPtyRecord('retained-pty', context)).toBeNull()
    expect(f.owner.handles.has('term_retained')).toBe(false)
    expect(f.owner.syntheticTerminalHandles.has('term_retained')).toBe(false)
    expect(f.owner.handleByLeafKey.get(`tab-original::${LEAF}`)).toBe(handle)
    expect(f.owner.handles.get(handle)?.ptyId).toBe('retained-pty')
    expect(f.owner.handleByPtyIncarnation.get('retained-pty')?.handle).toBe(handle)
    expect(f.owner.rejectWaitersForHandle).toHaveBeenCalledWith(
      'term_retained',
      'terminal_handle_stale'
    )
    return {
      retainedRemoved: !f.owner.handles.has('term_retained'),
      synthetic: f.owner.syntheticTerminalHandles.size,
      rejected: vi.mocked(f.owner.rejectWaitersForHandle).mock.calls
    }
  }
  expect(run(true)).toEqual(run(false))
})
