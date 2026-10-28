// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { useEditorConflictNavigation } from './useEditorConflictNavigation'

const state = vi.hoisted(() => ({ setPendingEditorReveal: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (store: typeof state) => unknown) => selector(state)
}))

const file: OpenFile = {
  id: 'file-host-a',
  filePath: '/repo/conflicted.ts',
  relativePath: 'conflicted.ts',
  worktreeId: 'workspace-a',
  language: 'typescript',
  mode: 'edit',
  isDirty: false
}
const content = ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> branch'].join('\n')

describe('conflict navigation reveal ownership', () => {
  beforeEach(() => vi.clearAllMocks())

  it('targets the file owner and split view that requested navigation', async () => {
    const { result } = renderHook(() => useEditorConflictNavigation())
    await act(async () => {
      result.current(file, content, 'left-pane')?.onJump('next')
    })
    expect(state.setPendingEditorReveal).toHaveBeenLastCalledWith({
      fileId: file.id,
      filePath: file.filePath,
      viewStateId: 'left-pane',
      line: 1,
      column: 1,
      matchLength: 12
    })
  })

  it('keeps identical paths on another host tied to that file and view', async () => {
    const other = { ...file, id: 'file-host-b', worktreeId: 'workspace-b' }
    const { result } = renderHook(() => useEditorConflictNavigation())
    await act(async () => {
      result.current(other, content, 'review-overview:file')?.onJump('previous')
    })
    expect(state.setPendingEditorReveal).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileId: other.id, viewStateId: 'review-overview:file' })
    )
  })
})
