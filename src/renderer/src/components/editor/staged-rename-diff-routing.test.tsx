// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { useEditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'
import { fetchCombinedDiffSection } from './combined-diff/load-sections/fetch-combined-diff-section'

const mocks = vi.hoisted(() => ({ getDiff: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  requireRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/runtime/runtime-git-client-context', () => ({ getRuntimeGitScope: () => undefined }))
vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitDiff: mocks.getDiff,
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitBranchDiff: vi.fn()
}))
vi.mock('./editor-clean-tab-disk-baseline', () => ({ stampCleanTabDiskBaseline: vi.fn() }))

const file: OpenFile = {
  id: 'rename',
  worktreeId: 'wt-1',
  filePath: '/repo/new.ts',
  relativePath: 'new.ts',
  mode: 'diff',
  diffSource: 'staged',
  branchOldPath: 'old.ts',
  isDirty: false,
  language: 'typescript'
}

describe('staged rename diff routing', () => {
  beforeEach(() => {
    mocks.getDiff.mockReset().mockResolvedValue({
      kind: 'text',
      originalContent: 'before',
      modifiedContent: 'after',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
  })

  it.each(['staged', 'unstaged'] as const)(
    'passes the source path only for a single %s diff',
    async (diffSource) => {
      const { result } = renderHook(() =>
        useEditorPanelDiffContentLoader({
          diffReadGenerationCounterRef: { current: 0 },
          diffReadGenerationRef: { current: {} },
          outstandingDiffReadsRef: { current: {} },
          setDiffContents: vi.fn()
        })
      )

      await result.current({ ...file, diffSource })

      expect(mocks.getDiff).toHaveBeenCalledWith(expect.anything(), {
        filePath: 'new.ts',
        staged: diffSource === 'staged',
        compareAgainstHead: false,
        ...(diffSource === 'staged' ? { oldPath: 'old.ts' } : {})
      })
    }
  )

  it.each(['staged', 'unstaged'] as const)(
    'passes the source path only for a combined %s diff',
    async (area) => {
      await fetchCombinedDiffSection({
        file: { ...file, filePath: '/repo', diffSource: 'combined-uncommitted' },
        entry: { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', area },
        branchCompare: null,
        commitCompare: null,
        isAllMode: false,
        isBranchMode: false,
        isCommitMode: false
      })

      expect(mocks.getDiff).toHaveBeenCalledWith(expect.anything(), {
        filePath: 'new.ts',
        staged: area === 'staged',
        ...(area === 'staged' ? { oldPath: 'old.ts' } : {})
      })
    }
  )
})
