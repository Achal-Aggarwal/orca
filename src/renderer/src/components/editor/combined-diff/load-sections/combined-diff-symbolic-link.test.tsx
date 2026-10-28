// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffSection } from '../../diff-section-types'
import type { CombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { useCombinedDiffSectionLoadRegistry } from './combined-diff-section-load-registry'
import { useCombinedDiffSectionLoader } from './use-combined-diff-section-loader'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('./fetch-combined-diff-section', () => ({ fetchCombinedDiffSection: mocks.fetch }))
afterEach(() => {
  cleanup()
  mocks.fetch.mockReset()
})
const file: OpenFile = {
  id: 'diff',
  filePath: '/repo',
  relativePath: '',
  worktreeId: 'wt',
  isDirty: false,
  language: 'plaintext',
  mode: 'diff',
  diffSource: 'combined-uncommitted'
}
const entries = [{ path: 'link', status: 'modified' as const, area: 'unstaged' as const }]
const entrySet: CombinedDiffEntrySet = {
  entries,
  uncommittedEntries: entries,
  allEntries: entries,
  branchCompare: null,
  commitCompare: null,
  commitEntries: [],
  entrySignature: 'one',
  hasUncommittedEntriesSnapshot: true,
  isAllMode: false,
  isBranchMode: false,
  isCommitMode: false,
  renderableBranchEntries: [],
  shouldAutoReloadFromGitStatus: false,
  treeMode: 'uncommitted'
}
const loaded = {
  kind: 'text' as const,
  originalContent: 'old-target',
  modifiedContent: 'new-target',
  originalIsBinary: false as const,
  modifiedIsBinary: false as const
}
function initial(dirty: boolean): DiffSection {
  return {
    key: 'unstaged:link',
    path: 'link',
    status: 'modified',
    area: 'unstaged',
    originalContent: 'old-target',
    modifiedContent: dirty ? 'preserved draft' : 'new-target',
    collapsed: false,
    loading: false,
    dirty,
    diffResult: loaded,
    largeDiffRenderLimit: null
  }
}

it.each([false, true])(
  'updates link classification for a dirty=%s section without replacing its draft',
  async (dirty) => {
    mocks.fetch.mockResolvedValue({ ...loaded, symbolicLink: true })
    const { result } = renderHook(() => {
      const [sections, setSections] = useState([initial(dirty)])
      const [, setSectionHeights] = useState<Record<number, number>>({})
      const registry = useCombinedDiffSectionLoadRegistry(sections)
      useCombinedDiffSectionLoader({
        entrySet,
        file,
        registry,
        sectionCount: 1,
        setSectionHeights,
        setSections
      })
      return sections
    })
    await act(async () => undefined)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(result.current[0]).toMatchObject({
      dirty,
      modifiedContent: dirty ? 'preserved draft' : 'new-target',
      diffResult: { symbolicLink: true, modifiedContent: 'new-target' }
    })
  }
)
