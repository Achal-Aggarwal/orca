// @vitest-environment happy-dom

import { useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import type { readEditorCsvFileContent } from './csv/csv-file-content'
import type {
  migrateRestoredEditorFileOwner,
  RestoredEditorOwnerMigrationResult
} from './migrate-restored-editor-file-owner'
import type { findRestoredEditorWorkspaceRuntimeOwner } from './restored-editor-workspace-runtime-owner'

const mocks = vi.hoisted(() => ({
  read: vi.fn<typeof readEditorCsvFileContent>(),
  migrate: vi.fn<typeof migrateRestoredEditorFileOwner>(),
  restoredOwner: vi.fn<typeof findRestoredEditorWorkspaceRuntimeOwner>(),
  getState: vi.fn(() => ({ editorDrafts: {} }))
}))

vi.mock('./csv/csv-file-content', () => ({ readEditorCsvFileContent: mocks.read }))
vi.mock('./migrate-restored-editor-file-owner', () => ({
  migrateRestoredEditorFileOwner: mocks.migrate
}))
vi.mock('./restored-editor-workspace-runtime-owner', () => ({
  findRestoredEditorWorkspaceRuntimeOwner: mocks.restoredOwner
}))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: vi.fn(() => null),
  isWorktreeConnectionResolved: vi.fn(() => true)
}))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: vi.fn(() => ({ kind: 'local' })),
  requireRuntimeTargetForFileOwner: vi.fn(() => ({ kind: 'local' }))
}))
vi.mock('@/lib/worktree-host-connection-phase', () => import('./local-host-test-fixture'))
vi.mock('./editor-clean-tab-disk-baseline', () => ({ stampCleanTabDiskBaseline: vi.fn() }))
vi.mock('./editor-autosave', () => ({
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT: 'external',
  ORCA_EDITOR_FILE_CACHE_STALE_EVENT: 'stale',
  ORCA_EDITOR_FILE_SAVED_EVENT: 'saved'
}))

import { usePruneClosedEditorContent } from './useEditorPanelExternalContentEvents'
import { useEditorPanelFileContentLoader } from './useEditorPanelFileContentLoader'

function createFile(index = 0): OpenFile {
  return {
    id: `/repo/src/report-${index}.ts`,
    filePath: `/repo/src/report-${index}.ts`,
    relativePath: `src/report-${index}.ts`,
    worktreeId: 'repo::/repo',
    language: 'typescript',
    mode: 'edit',
    isDirty: false
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function useContentProbe(files: OpenFile[]) {
  const openFilesRef = useRef(files)
  openFilesRef.current = files
  const retries = useRef<Record<string, number>>({})
  const readGenerations = useRef<Record<string, number>>({})
  const diffGenerations = useRef<Record<string, number>>({})
  const counter = useRef(0)
  const outstanding = useRef<Record<string, number>>({})
  const [fileContents, setFileContents] = useState<Record<string, FileContent>>({})
  const [diffContents, setDiffContents] = useState<Record<string, DiffContent>>({})
  usePruneClosedEditorContent(
    files,
    retries,
    readGenerations,
    diffGenerations,
    setFileContents,
    setDiffContents
  )
  const load = useEditorPanelFileContentLoader({
    fileLoadRetryAttemptsRef: retries,
    fileReadGenerationCounterRef: counter,
    fileReadGenerationRef: readGenerations,
    openFilesRef,
    outstandingFileReadsRef: outstanding,
    setFileContents
  })
  return {
    load,
    retries,
    readGenerations,
    diffGenerations,
    outstanding,
    fileContents,
    diffContents
  }
}

beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue({ content: 'fresh', isBinary: false })
  mocks.migrate.mockReset()
  mocks.restoredOwner.mockReset().mockReturnValue(null)
})

afterEach(cleanup)

describe('editor content generation lifetime', () => {
  it('prunes successive preview tabs while allowing a retired ID to become conflict-only content', async () => {
    const view = renderHook(useContentProbe, { initialProps: [createFile()] })
    for (let index = 0; index < 100; index += 1) {
      const file = createFile(index)
      view.rerender([file])
      view.result.current.diffGenerations.current[file.id] = index + 1
      view.result.current.retries.current[file.id] = 1
      await act(() => view.result.current.load(file.filePath, file.id, file.worktreeId))
      expect(Object.keys(view.result.current.readGenerations.current)).toEqual([file.id])
      expect(Object.keys(view.result.current.diffGenerations.current)).toEqual([file.id])
      expect(Object.keys(view.result.current.fileContents)).toEqual([file.id])
    }
    view.rerender([])
    expect(view.result.current.readGenerations.current).toEqual({})
    expect(view.result.current.diffGenerations.current).toEqual({})
    expect(view.result.current.retries.current).toEqual({})
    expect(view.result.current.fileContents).toEqual({})

    const file = createFile()
    const pending = deferred<FileContent>()
    mocks.read.mockReturnValueOnce(pending.promise)
    let read: Promise<void> | undefined
    await act(async () => {
      read = view.result.current.load(file.filePath, file.id, file.worktreeId)
    })
    view.result.current.diffGenerations.current[file.id] = 101
    view.rerender([createFile(100)])
    await act(async () => {
      pending.resolve({ content: 'conflict review', isBinary: false })
      await read
    })
    expect(view.result.current.fileContents[file.id]?.content).toBe('conflict review')
    expect(view.result.current.readGenerations.current[file.id]).toBeDefined()
    expect(view.result.current.diffGenerations.current[file.id]).toBe(101)
  })

  it('preserves generation entries for conflict-only IDs that never owned a tab', () => {
    const file = createFile()
    const view = renderHook(useContentProbe, { initialProps: [file] })
    view.result.current.readGenerations.current.conflict = 1
    view.result.current.diffGenerations.current.conflict = 2
    view.rerender([])
    expect(view.result.current.readGenerations.current).toEqual({ conflict: 1 })
    expect(view.result.current.diffGenerations.current).toEqual({ conflict: 2 })
  })

  it.each(['success', 'failure'])(
    'ignores an old read %s after closing and reopening the ID',
    async (outcome) => {
      const file = createFile()
      const view = renderHook(useContentProbe, { initialProps: [file] })
      const pending = deferred<FileContent>()
      mocks.read.mockReturnValueOnce(pending.promise)
      let oldRead: Promise<void> | undefined
      await act(async () => {
        oldRead = view.result.current.load(file.filePath, file.id, file.worktreeId)
      })
      view.rerender([])
      view.rerender([file])
      await act(() => view.result.current.load(file.filePath, file.id, file.worktreeId))
      const freshGeneration = view.result.current.readGenerations.current[file.id]
      await act(async () => {
        if (outcome === 'success') {
          pending.resolve({ content: 'old', isBinary: false })
        } else {
          pending.reject(new Error('old failure'))
        }
        await oldRead
      })
      expect(view.result.current.fileContents[file.id]?.content).toBe('fresh')
      expect(view.result.current.readGenerations.current[file.id]).toBe(freshGeneration)
      expect(view.result.current.outstanding.current).toEqual({})
    }
  )

  it.each([false, true])(
    'fences a delayed successful owner migration (reopened: %s)',
    async (reopen) => {
      const file = createFile()
      const view = renderHook(useContentProbe, { initialProps: [file] })
      const pending = deferred<RestoredEditorOwnerMigrationResult>()
      mocks.migrate.mockReturnValueOnce(pending.promise)
      mocks.restoredOwner.mockReturnValueOnce({
        runtimeEnvironmentId: 'runtime-1',
        route: {
          worktreeId: file.worktreeId,
          relativePath: file.relativePath,
          executionHostId: 'runtime:runtime-1'
        }
      })
      let oldRead: Promise<void> | undefined
      await act(async () => {
        oldRead = view.result.current.load(file.filePath, file.id, file.worktreeId)
      })
      expect(mocks.migrate).toHaveBeenCalledOnce()
      view.rerender([])
      if (reopen) {
        view.rerender([file])
        await act(() => view.result.current.load(file.filePath, file.id, file.worktreeId))
      }
      const freshGeneration = view.result.current.readGenerations.current[file.id]
      await act(async () => {
        pending.resolve({ ok: true, fileId: 'reowned-file' })
        await oldRead
      })
      expect(view.result.current.readGenerations.current[file.id]).toBe(freshGeneration)
      expect(view.result.current.fileContents[file.id]?.content).toBe(reopen ? 'fresh' : undefined)
      expect(view.result.current.outstanding.current).toEqual({})
    }
  )
})
