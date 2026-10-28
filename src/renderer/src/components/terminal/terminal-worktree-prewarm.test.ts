import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { revealActivationDeferredTabs } from './background-terminal-worktree-mount'
import {
  planTerminalPrewarmTabMount,
  undoTerminalPrewarmNarrowing
} from './terminal-worktree-prewarm'

function tab(id: string, ptyId: string | null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: 'wt',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const plan = (
  tabs: TerminalTab[],
  revealTabIds: string[],
  options: { live?: string[]; sleeping?: string[] } = {}
) =>
  planTerminalPrewarmTabMount({
    tabs,
    revealTabIds: new Set(revealTabIds),
    isTabLive: (tabId) => options.live?.includes(tabId) === true,
    isTabRestorable: (candidate) => candidate.ptyId !== null,
    isTabSleeping: (tabId) => options.sleeping?.includes(tabId) === true
  })

describe('planTerminalPrewarmTabMount', () => {
  it('mounts only the revealable tab and keeps restorable siblings parked', () => {
    expect(plan([tab('a', 'pty-a'), tab('b', 'pty-b'), tab('c', null)], ['a'])).toEqual({
      allowedTabIds: new Set(['a']),
      deferredTabIds: new Set(['b'])
    })
  })

  it('admits a live revealable tab without spawning its unrestorable siblings', () => {
    expect(plan([tab('a', 'pty-a'), tab('c', null)], ['a'], { live: ['a'] })).toEqual({
      allowedTabIds: new Set(['a']),
      deferredTabIds: new Set()
    })
  })

  it('never mounts a revealable tab that would spawn a shell or wake a sleeping agent', () => {
    expect(plan([tab('a', null)], ['a'])).toBeNull()
    expect(plan([tab('a', 'pty-a')], ['a'], { sleeping: ['a'] })).toBeNull()
  })
})

describe('undoTerminalPrewarmNarrowing', () => {
  it('leaves an activated workspace able to admit its deferred tabs after the lease releases', () => {
    const leaseAllowed = new Set(['live'])
    const restrictions = new Map<string, ReadonlySet<string>>([['wt', leaseAllowed]])
    const deferred = new Map<string, ReadonlySet<string>>([['wt', new Set(['p1', 'p2'])]])
    // Activation installs its own restriction while keeping the same deferred tabs.
    restrictions.set('wt', new Set(['live']))

    undoTerminalPrewarmNarrowing({
      restrictions,
      deferredMountTabIdsByWorktree: deferred,
      worktreeId: 'wt',
      narrowing: { allowedTabIds: leaseAllowed, deferredTabIds: new Set(['p1', 'p2']) },
      isActivated: true
    })
    revealActivationDeferredTabs({
      restrictions,
      deferredMountTabIdsByWorktree: deferred,
      worktreeId: 'wt',
      allTabIds: ['live', 'p1', 'p2'],
      immediateTabIds: new Set(['p1'])
    })

    expect(restrictions.get('wt')).toEqual(new Set(['live', 'p1']))
    expect(deferred.get('wt')).toEqual(new Set(['p2']))
  })

  it('hands back a narrowing the lease still owns, keeping deferrals it did not add', () => {
    const leaseAllowed = new Set(['live'])
    const restrictions = new Map<string, ReadonlySet<string>>([['wt', leaseAllowed]])
    const deferred = new Map<string, ReadonlySet<string>>([['wt', new Set(['earlier', 'p1'])]])

    undoTerminalPrewarmNarrowing({
      restrictions,
      deferredMountTabIdsByWorktree: deferred,
      worktreeId: 'wt',
      narrowing: { allowedTabIds: leaseAllowed, deferredTabIds: new Set(['p1']) },
      isActivated: false
    })

    expect(restrictions.has('wt')).toBe(false)
    expect(deferred.get('wt')).toEqual(new Set(['earlier']))
  })
})
