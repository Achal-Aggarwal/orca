// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore } from 'zustand/vanilla'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { createWorkItemMutationActions } from '@/store/github/work-item-mutation-actions'
import { useImmediateMutation } from '@/hooks/useImmediateMutation'
import * as registry from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { beginTaskPageGitHubWorkItemMutation } from '@/components/task-page/github/task-page-github-work-item-mutations'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { parseTaskQuery } from '../../../../../shared/task-query'
import { runGHEditAssigneeToggle } from './gh-edit-section-mutations'

const mocks = vi.hoisted(() => ({ update: vi.fn(), recordFeatureInteraction: vi.fn() }))
vi.mock('@/components/github/github-work-item-edit-mutations', () => ({
  runIssueUpdate: mocks.update
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ recordFeatureInteraction: mocks.recordFeatureInteraction }) }
}))

const original = { login: 'original', name: 'Original', avatarUrl: 'original-avatar' }
const pendingUser = { login: 'pending', name: 'Pending', avatarUrl: 'pending-avatar' }
const candidate = { login: 'candidate', name: 'Candidate', avatarUrl: 'candidate-avatar' }
const ownerRepo = { owner: 'upstream', repo: 'widgets', host: 'github.com' }
const item: GitHubWorkItem = {
  id: 'issue:5',
  repoId: 'registered-repo',
  type: 'issue',
  number: 5,
  title: 'Issue five',
  state: 'open',
  url: 'https://github.com/upstream/widgets/issues/5',
  labels: [],
  assignees: [original],
  updatedAt: '',
  author: null
}

afterEach(() => {
  registry.resetTaskPageGitHubMutationRegistryForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([false, true])(
  'bounds successful dialog publication at N/10N with a real Tasks cache (snapshot=%s)',
  async (hasSnapshot) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const measurements: { pending: number; rows: number }[] = []
    for (const population of [100, 1000]) {
      registry.resetTaskPageGitHubMutationRegistryForTests()
      const counts = { pending: 0, rows: 0 }
      const unrelated = Array.from({ length: population }, (_, index): GitHubWorkItem => ({
        ...item,
        get id() {
          counts.rows++
          return `issue:${index + 100}`
        }
      }))
      const twin = { ...item, url: 'https://github.com/fork/widgets/issues/5' }
      const store = createStore<AppState>()((set, get) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: patchWorkItem reads only the fixture's workItemsCache.
        return {
          workItemsCache: {
            related: { data: [...unrelated, item], fetchedAt: 1 },
            unrelated: { data: [...unrelated, twin], fetchedAt: 1 }
          },
          ...createWorkItemMutationActions(set, get)
        } as AppState
      })
      const patchWorkItem = vi.fn(store.getState().patchWorkItem)
      beginTaskPageGitHubWorkItemMutation({
        item,
        query: parseTaskQuery(''),
        queryKey: 'performance-query',
        viewerLogin: null,
        intent: { type: 'toggleAssignee', user: pendingUser },
        patchWorkItem
      })
      if (!hasSnapshot) {
        registry.deleteConfirmedListSnapshot(null, item.repoId, item.id, 'assignees', ownerRepo)
      }
      for (let index = 0; index < population; index++) {
        const key = {
          sourceScope: null,
          repoId: 'unrelated-repo',
          itemId: `issue:${index + 100}`,
          opKey: 'assignees:pending'
        }
        registry.setPendingTaskPageGitHubOp({
          get key() {
            counts.pending++
            return key
          },
          generation: 1,
          startedAt: index,
          previous: { assignees: [original] },
          next: { assignees: [original, pendingUser] },
          listOp: { family: 'assignees', kind: 'add', logins: ['pending'], users: [pendingUser] },
          skipMeQualifiers: false
        })
      }
      const dialogItem = store.getState().workItemsCache.related.data?.at(-1)
      expect(dialogItem).toBeDefined()
      if (!dialogItem) {
        throw new Error('Missing Tasks row')
      }
      const onMutated = vi.fn()
      function DialogAction(): React.JSX.Element {
        const { run } = useImmediateMutation()
        return (
          <button
            onClick={() =>
              runGHEditAssigneeToggle({
                item: dialogItem ?? item,
                itemNumber: item.number,
                itemRepoId: item.repoId,
                knownAssignees: [original, pendingUser, candidate],
                login: candidate.login,
                localAssignees: [original.login, pendingUser.login],
                assigneesItemKey: 'performance-item',
                editedAssigneesItemKeyRef: { current: null },
                repoPath: null,
                projectOrigin: undefined,
                issueRepo: ownerRepo,
                run,
                setLocalAssignees: vi.fn(),
                patchWorkItem,
                patchProjectRowIfNeeded: vi.fn(),
                onMutated
              })
            }
          >
            Assign candidate
          </button>
        )
      }
      const container = document.createElement('div')
      const root = createRoot(container)
      let finish: (result: { ok: boolean }) => void = () => {}
      mocks.update.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const notify = vi.fn()
      const writes = vi.fn()
      const unsubscribeRegistry = registry.subscribeTaskPageGitHubMutationRegistry(notify)
      const unsubscribeStore = store.subscribe(writes)
      const snapshotWrites = vi.spyOn(registry, 'setConfirmedListSnapshot')
      try {
        await act(async () => root.render(<DialogAction />))
        await act(async () => container.querySelector('button')?.click())
        counts.pending = 0
        counts.rows = 0
        patchWorkItem.mockClear()
        const before = store.getState().workItemsCache
        expect(notify).not.toHaveBeenCalled()
        expect(writes).not.toHaveBeenCalled()
        expect(snapshotWrites).not.toHaveBeenCalled()
        await act(async () => finish({ ok: true }))
        measurements.push({ ...counts })

        // One cache pass and at most two registry passes; neither population multiplies the other.
        expect(counts.rows).toBeGreaterThanOrEqual(population * 2)
        expect(counts.rows).toBeLessThanOrEqual(population * 2 + 2)
        expect(counts.pending).toBeGreaterThanOrEqual(population)
        expect(counts.pending).toBeLessThanOrEqual(population * 2)
        expect(notify).toHaveBeenCalledTimes(1)
        expect(writes).toHaveBeenCalledTimes(1)
        expect(snapshotWrites).toHaveBeenCalledTimes(1)
        expect(patchWorkItem).toHaveBeenCalledTimes(1)
        expect(onMutated).toHaveBeenCalledTimes(1)
        const after = store.getState().workItemsCache
        expect(after.related.data?.at(-1)?.assignees).toEqual([original, candidate, pendingUser])
        expect(
          registry.getConfirmedListSnapshot(null, item.repoId, item.id, 'assignees', ownerRepo)
        ).toEqual([original, candidate])
        expect(after.related.data?.slice(0, -1)).toEqual(unrelated)
        expect(after.unrelated).toBe(before.unrelated)
        expect(after.unrelated.data?.at(-1)?.assignees).toEqual([original])
      } finally {
        snapshotWrites.mockRestore()
        unsubscribeRegistry()
        unsubscribeStore()
        act(() => root.unmount())
        container.remove()
      }
    }
    expect(measurements[1].pending).toBeLessThanOrEqual(measurements[0].pending * 10)
    expect(measurements[1].rows).toBeLessThanOrEqual(measurements[0].rows * 10)
  }
)
