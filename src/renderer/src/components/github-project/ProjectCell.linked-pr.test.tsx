// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Repo } from '../../../../shared/repo-types'
import ProjectViewList from './ProjectViewList'
import { useProjectRowActions } from './useProjectRowActions'
import { linkedPullRequestsTable } from './ProjectCell.test-fixture'

const { lookupSlugMatches } = vi.hoisted(() => ({ lookupSlugMatches: vi.fn() }))
vi.mock('@/lib/repo-slug-index', () => ({
  useRepoSlugIndex: () => ({ ready: true, lookupSlug: () => [], lookupSlugMatches })
}))
vi.mock('./useProjectRowMutations', () => ({ useProjectRowMutations: () => ({}) }))
vi.mock('@/lib/launch-work-item-direct', () => ({ launchWorkItemDirect: vi.fn() }))

const initialState = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

it('opens each linked PR in its own repository without opening or selecting the issue row', () => {
  const repo: Repo = {
    id: 'api',
    path: '/repos/api',
    displayName: 'API',
    badgeColor: '#000',
    addedAt: 1
  }
  useAppStore.setState({ repos: [repo] })
  lookupSlugMatches.mockImplementation((slug, host) => ({
    origin: slug === 'other/api' && host === 'github.example.com' ? [repo] : [],
    upstream: []
  }))
  const openUrl = vi.fn().mockResolvedValue(undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  const rowClick = vi.fn()
  const selectedRepoIds = new Set(['api'])
  function Harness() {
    const actions = useProjectRowActions({
      table: linkedPullRequestsTable,
      currentCacheKey: 'cache',
      selectedRepoIds
    })
    return (
      <TooltipProvider>
        <div onClick={rowClick} onKeyDown={rowClick}>
          <ProjectViewList
            table={linkedPullRequestsTable}
            sourceTarget={{ kind: 'local' }}
            onOpenDialog={actions.openDialog}
          />
        </div>
        <output data-testid="opened-pr">{JSON.stringify(actions.resolvedDialogRepoItem)}</output>
      </TooltipProvider>
    )
  }
  render(<Harness />)
  const crossRepoPR = screen.getByRole('button', { name: '#93' })
  expect(crossRepoPR.getAttribute('title')).toBe('Support cross-repository links')
  crossRepoPR.focus()
  expect(document.activeElement).toBe(crossRepoPR)
  fireEvent.keyDown(crossRepoPR, { key: 'Enter' })
  fireEvent.click(crossRepoPR)
  const opened = JSON.parse(screen.getByTestId('opened-pr').textContent ?? 'null')
  expect(opened).toMatchObject({
    repoId: 'api',
    workItem: {
      type: 'pr',
      number: 93,
      title: 'Support cross-repository links',
      url: 'https://github.example.com/other/api/pull/93',
      prRepo: { owner: 'other', repo: 'api', host: 'github.example.com' }
    }
  })
  expect(opened.origin).toBeUndefined()
  fireEvent.click(screen.getByRole('button', { name: '#42' }))
  expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/app/pull/42')
  expect(rowClick).not.toHaveBeenCalled()
  expect(screen.getByText(/\+2/).closest('button')).toBeNull()
})
