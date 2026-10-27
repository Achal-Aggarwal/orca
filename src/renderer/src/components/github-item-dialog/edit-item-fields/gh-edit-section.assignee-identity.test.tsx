// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubItemDialogProjectOrigin } from '../load-item-details/github-item-dialog-types'
import { GHEditSection } from './gh-edit-section'
import {
  resetTaskPageGitHubMutationRegistryForTests,
  getConfirmedListSnapshot,
  getTaskPageGitHubMutationQueryKey,
  setConfirmedListSnapshot,
  setTaskPageGitHubMutationQueryKey
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { materializeTaskPageItemList } from '@/components/task-page/github/task-page-github-work-item-mutation-pages'
import { adoptQuietSearchFieldsForItem } from '@/components/task-page/github/task-page-github-work-item-quiet-adopt'
import { getOrCreateQuietRevalidateState } from '@/components/task-page/github/task-page-github-work-item-quiet-state'
import { beginTaskPageGitHubWorkItemMutation } from '@/components/task-page/github/task-page-github-work-item-mutations'
import {
  confirmTaskPageGitHubWorkItemMutation,
  rollbackTaskPageGitHubWorkItemMutation
} from '@/components/task-page/github/task-page-github-work-item-mutation-lifecycle'
import { parseTaskQuery } from '../../../../../shared/task-query'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  patchWorkItem: vi.fn(),
  patchProjectRowContent: vi.fn(),
  recordFeatureInteraction: vi.fn(),
  onMutated: vi.fn()
}))

vi.mock('@/store', () => {
  const state = {
    patchWorkItem: mocks.patchWorkItem,
    patchProjectRowContent: mocks.patchProjectRowContent,
    recordFeatureInteraction: mocks.recordFeatureInteraction,
    repos: [],
    settings: null
  }
  return {
    useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state
    })
  }
})

vi.mock('@/hooks/useIssueMetadata', async () => {
  const { useImmediateMutation } = await import('@/hooks/useImmediateMutation')
  return {
    useImmediateMutation,
    useRepoLabels: () => ({ data: [] }),
    useRepoAssignees: () => ({
      data: [{ login: 'candidate-user', name: 'Candidate', avatarUrl: 'https://avatar/candidate' }]
    })
  }
})
vi.mock('@/hooks/useGitHubSlugMetadata', () => ({
  useRepoLabelsBySlug: () => ({ data: [] }),
  useRepoAssigneesBySlug: () => ({ data: [] })
}))
vi.mock('@/components/github/github-duplicate-issue-candidates', () => ({
  useGitHubDuplicateIssueCandidates: () => []
}))
vi.mock('@/components/github/github-work-item-edit-mutations', () => ({
  runIssueUpdate: mocks.update
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./gh-edit-section-horizontal', () => ({ GHEditSectionHorizontal: () => null }))
vi.mock('./gh-edit-section-top-columns', () => ({
  GHEditSectionTopColumns: ({
    localAssignees,
    onAssigneeToggle,
    localState,
    localLabels,
    onStateChange,
    onLabelToggle
  }: {
    localAssignees: string[]
    onAssigneeToggle: (login: string) => void
    localState: GitHubWorkItem['state']
    localLabels: string[]
    onStateChange: (state: 'open' | 'closed') => void
    onLabelToggle: (label: string) => void
  }) => (
    <>
      <output data-field="assignees">{localAssignees.join(',')}</output>
      <output data-field="state">{localState}</output>
      <output data-field="labels">{localLabels.join(',')}</output>
      <button onClick={() => onAssigneeToggle('candidate-user')}>Assign candidate</button>
      <button onClick={() => onAssigneeToggle('original-user')}>Toggle original</button>
      <button onClick={() => onStateChange('closed')}>Close issue</button>
      <button onClick={() => onLabelToggle('candidate-label')}>Toggle label</button>
    </>
  )
}))

const item: GitHubWorkItem = {
  id: 'issue:5',
  repoId: 'registered-repo',
  type: 'issue',
  number: 5,
  title: 'Issue five',
  state: 'open',
  url: 'https://github.com/upstream/widgets/issues/5',
  labels: [],
  updatedAt: '',
  author: null
}
let root: Root
let container: HTMLDivElement

async function render(
  nextItem = item,
  assignees: string[] = [],
  projectOrigin?: GitHubItemDialogProjectOrigin,
  sourceContext?: TaskSourceContext
): Promise<void> {
  await act(async () => {
    root.render(
      <GHEditSection
        item={nextItem}
        repoPath={null}
        repoId={nextItem.repoId}
        projectOrigin={projectOrigin}
        sourceContext={sourceContext}
        localState="open"
        localLabels={[]}
        onStateChange={() => {}}
        onLabelsChange={() => {}}
        onMutated={mocks.onMutated}
        assignees={assignees}
        onUse={() => {}}
        layout="top-columns"
      />
    )
  })
}

async function click(label = 'Assign candidate'): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label
  )
  expect(button).toBeDefined()
  await act(async () => button?.click())
}

function selected(): string | null {
  return container.querySelector('[data-field="assignees"]')?.textContent ?? null
}

let updateParentSelection: (nextItem: GitHubWorkItem) => void = () => {}

function ParentSelection({ item }: { item: GitHubWorkItem }): React.JSX.Element {
  const [localState, setLocalState] = useState(item.state)
  const [localLabels, setLocalLabels] = useState(item.labels)
  updateParentSelection = (nextItem) => {
    setLocalState(nextItem.state)
    setLocalLabels(nextItem.labels)
  }
  return (
    <GHEditSection
      item={item}
      repoPath={null}
      repoId={item.repoId}
      projectOrigin={undefined}
      localState={localState}
      localLabels={localLabels}
      onStateChange={setLocalState}
      onLabelsChange={setLocalLabels}
      onMutated={mocks.onMutated}
      assignees={[]}
      onUse={() => {}}
      layout="top-columns"
    />
  )
}

async function renderParent(nextItem: GitHubWorkItem): Promise<void> {
  await act(async () => {
    updateParentSelection(nextItem)
    root.render(<ParentSelection item={nextItem} />)
  })
}

describe('opened issue assignee ownership', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.clearAllMocks()
    mocks.patchWorkItem.mockReset()
    resetTaskPageGitHubMutationRegistryForTests()
    updateParentSelection = () => {}
    mocks.update.mockResolvedValue({ ok: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    resetTaskPageGitHubMutationRegistryForTests()
  })

  it.each([false, true])(
    'publishes dialog assignees to Tasks until search agrees (removing=%s)',
    async (removing) => {
      const candidate = {
        login: 'candidate-user',
        name: 'Candidate',
        avatarUrl: 'https://avatar/candidate'
      }
      const original = {
        login: 'original-user',
        name: 'Original',
        avatarUrl: 'https://avatar/original'
      }
      const stale = { ...item, assignees: removing ? [original, candidate] : [original] }
      const expected = removing ? [original] : [original, candidate]
      let row = stale
      let finish: (result: { ok: boolean }) => void = () => {}
      mocks.update.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      mocks.patchWorkItem.mockImplementation((_id, patch) => {
        row = { ...row, ...patch }
      })
      setTaskPageGitHubMutationQueryKey('assignee-query')
      await render(
        stale,
        stale.assignees.map((user) => user.login)
      )
      await click()
      expect(row.assignees).toEqual(stale.assignees)
      await act(async () => finish({ ok: true }))
      expect(row.assignees).toEqual(expected)
      expect(mocks.patchWorkItem).toHaveBeenLastCalledWith(
        item.id,
        { assignees: expected },
        item.repoId,
        {
          sourceContext: undefined,
          ownerRepo: { owner: 'upstream', repo: 'widgets', host: 'github.com' }
        }
      )
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          issueRepo: { owner: 'upstream', repo: 'widgets', host: 'github.com' },
          updates: removing
            ? { removeAssignees: ['candidate-user'] }
            : { addAssignees: ['candidate-user'] }
        })
      )
      const otherRepo = { ...stale, url: 'https://github.com/fork/widgets/issues/5' }
      expect(
        materializeTaskPageItemList({
          networkItems: [otherRepo],
          previousItems: [],
          queryKey: 'assignee-query'
        })[0]?.assignees
      ).toEqual(stale.assignees)
      const materialize = () =>
        materializeTaskPageItemList({
          networkItems: [stale],
          previousItems: [row],
          queryKey: 'assignee-query'
        })[0]?.assignees
      const adopt = (serverItem: GitHubWorkItem) =>
        adoptQuietSearchFieldsForItem({
          item: row,
          serverItem,
          sourceScope: null,
          queryKey: 'assignee-query',
          fetchStartedAtGeneration:
            getOrCreateQuietRevalidateState('assignee-query').dirtyGeneration,
          patchWorkItem: mocks.patchWorkItem
        })
      expect(materialize()).toEqual(expected)
      adopt(stale)
      expect(materialize()).toEqual(expected)
      adopt({ ...row, assignees: expected })
      expect(materialize()).toEqual(stale.assignees)
    }
  )

  it.each(['throw', 'result'])(
    'leaves Tasks authority untouched when a dialog edit fails (%s)',
    async (failure) => {
      const stale = { ...item, assignees: [] }
      let row: GitHubWorkItem = stale
      mocks.patchWorkItem.mockImplementation((_id, patch) => {
        row = { ...row, ...patch }
      })
      let fail: (reason: Error) => void = () => {}
      let finish: (result: { ok: boolean }) => void = () => {}
      mocks.update.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            fail = reject
            finish = resolve
          })
      )
      await render(stale)
      await click()
      const sibling = [{ login: 'sibling', name: null, avatarUrl: '' }]
      setConfirmedListSnapshot(null, item.repoId, item.id, 'assignees', sibling, {
        owner: 'upstream',
        repo: 'widgets',
        host: 'github.com'
      })
      await act(async () =>
        failure === 'throw' ? fail(new Error('Assignment failed')) : finish({ ok: false })
      )
      expect(mocks.patchWorkItem).not.toHaveBeenCalled()
      expect(row.assignees).toEqual([])
      const external = [{ login: 'external', name: null, avatarUrl: '' }]
      expect(
        materializeTaskPageItemList({
          networkItems: [{ ...stale, assignees: external }],
          previousItems: [row],
          queryKey: 'q'
        })[0]?.assignees
      ).toEqual(sibling)
      expect(selected()).toBe('')
    }
  )

  it.each([
    { dialogFirst: false, succeeds: false },
    { dialogFirst: true, succeeds: false },
    { dialogFirst: false, succeeds: true },
    { dialogFirst: true, succeeds: true }
  ])(
    'composes a pending Tasks edit with dialog success ($dialogFirst/$succeeds)',
    async ({ dialogFirst, succeeds }) => {
      const base = { ...item, assignees: [] }
      let row: GitHubWorkItem = base
      mocks.patchWorkItem.mockImplementation((_id, patch) => {
        row = { ...row, ...patch }
      })
      const context = {
        item: base,
        query: parseTaskQuery(''),
        queryKey: 'q',
        viewerLogin: null,
        patchWorkItem: mocks.patchWorkItem
      }
      const pending = beginTaskPageGitHubWorkItemMutation({
        ...context,
        intent: {
          type: 'toggleAssignee',
          user: { login: 'alice', name: 'Alice', avatarUrl: 'alice-avatar' }
        }
      })
      let finish: (result: { ok: boolean }) => void = () => {}
      mocks.update.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      await render(row, ['alice'])
      await click()
      const settleRow = () =>
        succeeds
          ? confirmTaskPageGitHubWorkItemMutation(pending.key, pending.generation, context)
          : rollbackTaskPageGitHubWorkItemMutation({ ...context, ...pending })
      if (!dialogFirst) {
        settleRow()
      }
      await act(async () => finish({ ok: true }))
      if (dialogFirst) {
        settleRow()
      }
      expect(
        materializeTaskPageItemList({
          networkItems: [base],
          previousItems: [row],
          queryKey: 'q'
        })[0]
          ?.assignees?.map((user) => user.login)
          .sort()
      ).toEqual(succeeds ? ['alice', 'candidate-user'] : ['candidate-user'])
      expect(row.assignees?.map((user) => user.login).sort()).toEqual(
        succeeds ? ['alice', 'candidate-user'] : ['candidate-user']
      )
    }
  )

  it.each([false, true])(
    'publishes Project edits without changing Tasks query ownership (query=%s)',
    async (hasQuery) => {
      const ownerRepo = { owner: 'upstream', repo: 'widgets', host: 'github.com' }
      if (hasQuery) {
        setTaskPageGitHubMutationQueryKey('unrelated-query')
      }
      setConfirmedListSnapshot(null, 'other-repo', 'issue:9', 'assignees', [], ownerRepo)
      const origin = {
        ...ownerRepo,
        number: 5,
        type: 'issue' as const,
        projectId: 'project',
        projectItemId: 'row',
        cacheKey: 'project-cache'
      }
      await render(item, [], origin)
      await click()
      expect(getTaskPageGitHubMutationQueryKey()).toBe(hasQuery ? 'unrelated-query' : null)
      expect(
        getConfirmedListSnapshot(null, 'other-repo', 'issue:9', 'assignees', ownerRepo)
      ).toEqual([])
      expect(mocks.patchWorkItem).toHaveBeenLastCalledWith(
        item.id,
        { assignees: [{ login: 'candidate-user', name: null, avatarUrl: '' }] },
        item.repoId,
        { sourceContext: undefined, ownerRepo: origin }
      )
    }
  )

  it.each(['dialog', 'row', 'server'])(
    'qualifies %s snapshots and quiet release by repository',
    async (writer) => {
      const ownerRepo = { owner: 'upstream', repo: 'widgets', host: 'github.com' }
      const user = { login: 'candidate-user', name: null, avatarUrl: '' }
      const base = { ...item, assignees: [] }
      setTaskPageGitHubMutationQueryKey('q')
      if (writer === 'dialog') {
        await render(base)
        await click()
      } else {
        const context = {
          item: base,
          query: parseTaskQuery(''),
          queryKey: 'q',
          viewerLogin: null,
          patchWorkItem: mocks.patchWorkItem
        }
        const pending = beginTaskPageGitHubWorkItemMutation({
          ...context,
          intent: { type: 'toggleAssignee', user }
        })
        expect(
          getConfirmedListSnapshot(null, item.repoId, item.id, 'assignees', {
            ...ownerRepo,
            owner: 'fork'
          })
        ).toBeUndefined()
        confirmTaskPageGitHubWorkItemMutation(pending.key, pending.generation, {
          ...context,
          ...(writer === 'server' ? { serverEntity: { assignees: [user] } } : {})
        })
      }
      const materialize = (row: GitHubWorkItem) =>
        materializeTaskPageItemList({
          networkItems: [row],
          previousItems: [],
          queryKey: 'q'
        })[0]?.assignees
      const adopt = (row: GitHubWorkItem) =>
        adoptQuietSearchFieldsForItem({
          item: row,
          serverItem: row,
          sourceScope: null,
          queryKey: 'q',
          fetchStartedAtGeneration: getOrCreateQuietRevalidateState('q').dirtyGeneration,
          patchWorkItem: mocks.patchWorkItem
        })
      for (const url of [
        'https://github.com/fork/widgets/issues/5',
        'https://ghe.example/upstream/widgets/issues/5'
      ]) {
        const twin = { ...base, url }
        expect(materialize(twin)).toEqual([])
        expect(adopt(twin).needTrailing).toBe(false)
        expect(materialize(base)?.map((user) => user.login)).toEqual(['candidate-user'])
      }
      adopt({ ...base, assignees: [user] })
      expect(materialize(base)).toEqual([])
    }
  )

  it('publishes into the dialog source scope and carries it to the cache patch', async () => {
    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      hostId: 'local' as const,
      projectId: 'project',
      projectHostSetupId: 'setup',
      repoId: item.repoId
    }
    await render(item, [], undefined, sourceContext)
    await click()
    expect(
      getConfirmedListSnapshot(
        getTaskSourceCacheScope(sourceContext),
        item.repoId,
        item.id,
        'assignees'
      )?.map((user) => user.login)
    ).toEqual(['candidate-user'])
    expect(getConfirmedListSnapshot(null, item.repoId, item.id, 'assignees')).toBeUndefined()
    expect(mocks.patchWorkItem).toHaveBeenCalledWith(item.id, expect.anything(), item.repoId, {
      sourceContext,
      ownerRepo: { owner: 'upstream', repo: 'widgets', host: 'github.com' }
    })
  })

  it('retires an optimistic selection across fork and return navigation', async () => {
    await render()
    await click()
    expect(selected()).toBe('candidate-user')
    await render(item, [])
    expect(selected()).toBe('candidate-user')

    await render({ ...item, url: 'https://github.com/fork/widgets/issues/5' }, ['fork-user'])
    expect(selected()).toBe('fork-user')
    await render(item, ['authoritative-upstream-user'])
    expect(selected()).toBe('authoritative-upstream-user')
  })

  it('does not revive an edited guard when returning from a different issue number', async () => {
    await render()
    await click()
    await render({ ...item, id: 'issue:6', number: 6 }, ['other-issue-user'])
    expect(selected()).toBe('other-issue-user')
    await render(item, ['authoritative-upstream-user'])
    expect(selected()).toBe('authoritative-upstream-user')
  })

  it.each(['Assign candidate', 'Toggle original'])(
    'does not roll a late failed %s edit into another opened issue',
    async (button) => {
      let rejectUpdate: (reason: Error) => void = () => {}
      mocks.update.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectUpdate = reject
          })
      )
      await render(item, ['original-user'])
      await click(button)
      await render({ ...item, id: 'issue:6', number: 6 }, ['other-issue-user'])
      expect(selected()).toBe('other-issue-user')
      await act(async () => rejectUpdate(new Error('held edit failed')))
      expect(selected()).toBe('other-issue-user')
    }
  )

  it('treats another GitHub host as a distinct same-number issue', async () => {
    await render()
    await click()
    await render({ ...item, url: 'https://github.example.test/upstream/widgets/issues/5' }, [])
    expect(selected()).toBe('')
  })

  it('retires the issue edit when the same legacy id is used by a pull request', async () => {
    await render()
    await click()
    await render({ ...item, type: 'pr' }, [])
    await render(item, ['authoritative-upstream-user'])
    expect(selected()).toBe('authoritative-upstream-user')
  })

  it('preserves optimistic edits across canonical URL casing and trailing paths', async () => {
    await render()
    await click()
    await render({ ...item, url: 'https://GITHUB.COM/Upstream/Widgets/issues/5#activity' }, [])
    expect(selected()).toBe('candidate-user')
  })

  it('uses the Project row repository before an unrelated item URL', async () => {
    const projectOrigin: GitHubItemDialogProjectOrigin = {
      owner: 'upstream',
      repo: 'widgets',
      number: 5,
      type: 'issue',
      projectId: 'project',
      projectItemId: 'row',
      cacheKey: 'project-cache'
    }
    await render(item, [], projectOrigin)
    await click()
    await render(
      { ...item, url: 'https://github.com/unrelated/widgets/issues/5' },
      [],
      projectOrigin
    )
    expect(selected()).toBe('candidate-user')
    await render(item, ['fork-user'], { ...projectOrigin, owner: 'fork' })
    expect(selected()).toBe('fork-user')
  })

  it('still rolls back a failed edit while its issue remains open', async () => {
    mocks.update.mockRejectedValue(new Error('edit failed'))
    await render(item, ['original-user'])
    await click()
    expect(selected()).toBe('original-user')
    await render(item, ['refetched-user'])
    expect(selected()).toBe('refetched-user')
  })

  it('keeps a late Project-row rollback scoped to the captured row', async () => {
    const projectOrigin: GitHubItemDialogProjectOrigin = {
      owner: 'upstream',
      repo: 'widgets',
      number: 5,
      type: 'issue',
      projectId: 'project',
      projectItemId: 'upstream-row',
      cacheKey: 'upstream-cache'
    }
    let rejectUpdate: (reason: Error) => void = () => {}
    mocks.update.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpdate = reject
        })
    )
    await render(item, ['original-user'], projectOrigin)
    await click()
    await render(item, ['fork-user'], {
      ...projectOrigin,
      owner: 'fork',
      projectItemId: 'fork-row',
      cacheKey: 'fork-cache'
    })
    expect(selected()).toBe('fork-user')
    await act(async () => rejectUpdate(new Error('held Project edit failed')))
    expect(selected()).toBe('fork-user')
    expect(mocks.patchProjectRowContent).toHaveBeenLastCalledWith(
      'upstream-cache',
      'upstream-row',
      { assignees: ['original-user'] }
    )
  })

  it.each([
    { button: 'Toggle label', field: 'labels', expected: 'fork-only-label' },
    { button: 'Close issue', field: 'state', expected: 'closed' }
  ])(
    'a late failed $field edit cannot overwrite the new parent selection',
    async ({ button, field, expected }) => {
      let rejectUpdate: (reason: Error) => void = () => {}
      mocks.update.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectUpdate = reject
          })
      )
      await renderParent({ ...item, labels: ['upstream-original-label'] })
      await click(button)
      await renderParent({
        ...item,
        state: 'closed',
        url: 'https://github.com/fork/widgets/issues/5',
        labels: ['fork-only-label']
      })
      expect(container.querySelector(`[data-field="${field}"]`)?.textContent).toBe(expected)
      await act(async () => rejectUpdate(new Error('held edit failed')))
      expect(container.querySelector(`[data-field="${field}"]`)?.textContent).toBe(expected)
      expect(mocks.patchWorkItem).toHaveBeenLastCalledWith(
        item.id,
        field === 'labels' ? { labels: ['upstream-original-label'] } : { state: 'open' },
        item.repoId,
        {
          sourceContext: undefined,
          ownerRepo: { owner: 'upstream', repo: 'widgets', host: 'github.com' }
        }
      )
    }
  )

  it.each([
    { button: 'Toggle label', field: 'labels', expected: 'upstream-original-label' },
    { button: 'Close issue', field: 'state', expected: 'open' }
  ])(
    'a same-item failed $field edit still restores its prior parent value',
    async ({ button, field, expected }) => {
      mocks.update.mockRejectedValue(new Error('same issue edit failed'))
      await renderParent({ ...item, labels: ['upstream-original-label'] })
      await click(button)
      expect(container.querySelector(`[data-field="${field}"]`)?.textContent).toBe(expected)
    }
  )
})
