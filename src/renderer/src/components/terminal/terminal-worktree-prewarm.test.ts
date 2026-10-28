import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { planTerminalPrewarmTabMount } from './terminal-worktree-prewarm'

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
