import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { makeFolderWorkspace } from './worktrees-slice-test-fixtures'
import { canGoBackWorktreeHistory, canGoForwardWorktreeHistory } from './worktree-nav-history'

describe('history availability subscriptions', () => {
  it.each([
    ['worktree', 100],
    ['worktree', 1000],
    ['folder', 100],
    ['folder', 1000]
  ] as const)('does not revisit %s catalog rows (%i) on unrelated writes', (kind, count) => {
    const store = createTestStore()
    let reads = 0
    const worktrees = Array.from({ length: count }, (_, index) => ({
      ...makeWorktree({ id: `live-${index}`, repoId: 'repo1' }),
      get id() {
        reads += 1
        return `live-${index}`
      }
    }))
    const folders = Array.from({ length: count }, (_, index) => ({
      ...makeFolderWorkspace({ id: `live-${index}` }),
      get id() {
        reads += 1
        return `live-${index}`
      }
    }))
    store.setState({
      worktreesByRepo: { repo1: worktrees },
      folderWorkspaces: folders,
      worktreeNavHistory: Array.from({ length: 50 }, (_, index) =>
        kind === 'folder' ? folderWorkspaceKey(`removed-${index}`) : `removed-${index}`
      ),
      worktreeNavHistoryIndex: 24
    })
    const readAvailability = (): void => {
      expect(canGoBackWorktreeHistory(store.getState())).toBe(false)
      expect(canGoForwardWorktreeHistory(store.getState())).toBe(false)
    }
    readAvailability()
    expect(reads).toBeGreaterThanOrEqual(49 * count)
    reads = 0
    const stop = store.subscribe(readAvailability)
    try {
      for (let index = 0; index < 200; index += 1) {
        store.setState({ sidebarWidth: 300 + index })
      }
      expect(reads).toBe(0)
    } finally {
      stop()
    }
  })

  it('rechecks history, cursor, git and folder catalog changes', () => {
    const store = createTestStore()
    store.setState({
      worktreeNavHistory: ['git', 'tasks', folderWorkspaceKey('folder')],
      worktreeNavHistoryIndex: 1
    })
    const availability = (): boolean[] => [
      canGoBackWorktreeHistory(store.getState()),
      canGoForwardWorktreeHistory(store.getState())
    ]
    expect(availability()).toEqual([false, false])
    store.setState({ worktreesByRepo: { repo1: [makeWorktree({ id: 'git', repoId: 'repo1' })] } })
    expect(availability()).toEqual([true, false])
    store.setState({ folderWorkspaces: [makeFolderWorkspace({ id: 'folder' })] })
    expect(availability()).toEqual([true, true])
    store.setState({ worktreesByRepo: {}, folderWorkspaces: [] })
    expect(availability()).toEqual([false, false])
    store.setState({ worktreeNavHistoryIndex: 0 })
    expect(availability()).toEqual([false, true])
    store.setState({ worktreeNavHistory: ['git', 'removed'] })
    expect(availability()).toEqual([false, false])
    store.setState({
      worktreeNavHistory: [
        'git',
        {
          kind: 'task-detail',
          source: 'linear',
          issue: {
            id: 'issue',
            identifier: 'TEST-1',
            title: 'Task',
            description: '',
            url: '',
            state: { name: 'Todo', type: 'unstarted', color: '' },
            priority: 0,
            labels: [],
            labelIds: [],
            updatedAt: '',
            team: { id: 'team', name: 'Team', key: 'TEST' }
          }
        }
      ]
    })
    expect(availability()).toEqual([false, true])
  })
})
