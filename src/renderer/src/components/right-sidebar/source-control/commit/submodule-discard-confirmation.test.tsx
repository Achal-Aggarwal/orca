// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { groupSourceControlEntries } from '../../../../../../shared/source-control-section-order'
import { getUnstageAllPaths } from '../../../../../../shared/source-control-discard-all-sequence'
import { SourceControlDiscardDialog } from './discard-dialog'
import { useSourceControlDiscardConfirmation } from './use-discard-confirmation'

const mocks = vi.hoisted(() => ({ bulkUnstage: vi.fn(async () => {}) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))
vi.mock('@/runtime/runtime-git-working-tree-client', () => ({
  bulkUnstageRuntimeGitPaths: mocks.bulkUnstage
}))

afterEach(cleanup)

describe('mixed staged submodule discard confirmation', () => {
  it('describes and executes only the ordinary file while preserving gitlink Unstage', async () => {
    const grouped = groupSourceControlEntries([
      { path: 'parent.ts', area: 'staged', status: 'modified' },
      {
        path: 'vendor',
        area: 'staged',
        status: 'modified',
        submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
      }
    ])
    const discardMany = vi.fn(async () => {})
    const refresh = vi.fn(async () => {})
    const { result } = renderHook(() =>
      useSourceControlDiscardConfirmation({
        activeRepoTarget: { kind: 'local' },
        activeWorktreeId: 'wt-1',
        worktreePath: '/repo',
        grouped,
        isExecutingBulk: false,
        setIsExecutingBulk: () => {},
        clearSelection: () => {},
        discardMany,
        discardSingle: async () => {},
        refreshActiveGitStatusAfterMutation: refresh
      })
    )
    act(() => result.current.requestDiscardAllInArea('staged'))
    expect(result.current.pendingDiscard).toEqual({
      kind: 'area',
      area: 'staged',
      paths: ['parent.ts']
    })
    render(
      <SourceControlDiscardDialog
        pendingDiscard={result.current.pendingDiscard}
        onCancel={result.current.cancelPendingDiscard}
        onConfirm={result.current.confirmPendingDiscard}
      />
    )

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Discard changes?')
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'This will unstage and revert the changes in this selection. Staged new files in this selection will be deleted. This cannot be undone.'
    )
    expect(screen.getByText('1 file')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(mocks.bulkUnstage).toHaveBeenCalledWith(
      {
        target: { kind: 'local' },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: undefined
      },
      ['parent.ts']
    )
    expect(discardMany).toHaveBeenCalledWith(['parent.ts'])
    expect(getUnstageAllPaths(grouped.staged)).toEqual(['parent.ts', 'vendor'])
  })
})
