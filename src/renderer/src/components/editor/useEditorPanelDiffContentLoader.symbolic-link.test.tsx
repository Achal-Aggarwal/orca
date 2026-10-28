// @vitest-environment happy-dom
import { useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { OpenFile } from '@/store/slices/editor'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { DiffContent } from './editor-panel-content-types'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { useEditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
let store: ReturnType<typeof createEditorStore>
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitDiff: mocks.read,
  getRuntimeGitBranchDiff: mocks.read,
  getRuntimeGitCommitDiff: mocks.read
}))
const file: OpenFile = {
  id: 'diff',
  filePath: '/repo/link.txt',
  relativePath: 'link.txt',
  worktreeId: 'wt-1',
  language: 'plaintext',
  mode: 'diff',
  diffSource: 'unstaged',
  isDirty: true
}
const linkResult: GitDiffResult = {
  kind: 'text',
  originalContent: 'old-target',
  modifiedContent: 'new-target',
  originalIsBinary: false,
  modifiedIsBinary: false,
  symbolicLink: true
}
function mount() {
  return renderHook(() => {
    const [contents, setDiffContents] = useState<Record<string, DiffContent>>({})
    const load = useEditorPanelDiffContentLoader({
      diffReadGenerationCounterRef: useRef(0),
      diffReadGenerationRef: useRef({}),
      outstandingDiffReadsRef: useRef({}),
      setDiffContents
    })
    return { load, contents }
  }).result
}
beforeEach(() => {
  store = createEditorStore()
  store.setState({ openFiles: [file], editorDrafts: { diff: 'preserved draft' } })
})
afterEach(() => {
  cleanup()
  mocks.read.mockReset()
})

it('marks the diff before publication without stamping the link path as a file baseline or dropping a draft', async () => {
  mocks.read.mockResolvedValue(linkResult)
  const result = mount()
  await act(() => result.current.load(file))
  expect(result.current.contents.diff).toEqual(linkResult)
  expect(store.getState().openFiles[0]).toMatchObject({ symbolicLink: true, isDirty: true })
  expect(store.getState().openFiles[0]?.lastKnownDiskSignature).toBeUndefined()
  expect(store.getState().editorDrafts.diff).toBe('preserved draft')
})

it('clears link classification when the working path becomes a regular file', async () => {
  store.getState().setDiffSymbolicLink(file.id, true)
  mocks.read.mockResolvedValue({
    ...linkResult,
    symbolicLink: undefined,
    modifiedContent: 'regular bytes'
  })
  const result = mount()
  await act(() => result.current.load(store.getState().openFiles[0]!))
  expect(store.getState().openFiles[0]?.symbolicLink).toBeUndefined()
  expect(store.getState().editorDrafts.diff).toBe('preserved draft')
})

it('ignores a link response after the tab changes owners', async () => {
  let resolve = (_value: GitDiffResult) => {}
  mocks.read.mockImplementation(
    () =>
      new Promise<GitDiffResult>((done) => {
        resolve = done
      })
  )
  const result = mount()
  let pending: Promise<void> = Promise.resolve()
  act(() => {
    pending = result.current.load(file)
  })
  store.setState({ openFiles: [{ ...file, runtimeEnvironmentId: 'other-host' }] })
  await act(async () => {
    resolve(linkResult)
    await pending
  })
  expect(result.current.contents.diff).toBeUndefined()
  expect(store.getState().openFiles[0]?.symbolicLink).toBeUndefined()
})

it('keeps ordinary edit-mode Changes reads on target bytes', async () => {
  const editor: OpenFile = { ...file, mode: 'edit', diffSource: undefined }
  store.setState({ openFiles: [editor] })
  mocks.read.mockResolvedValue({ ...linkResult, symbolicLink: undefined })
  const result = mount()
  await act(() => result.current.load(editor))
  expect(mocks.read.mock.calls[0]?.[1]).toMatchObject({ readSymbolicLinkTargets: false })
  expect(store.getState().openFiles[0]?.symbolicLink).toBeUndefined()
})

it('accepts equivalent hydrated ownership provenance rather than comparing object identity', async () => {
  const provenance = captureEditorFileOperationProvenance(
    store.getState(),
    file.worktreeId,
    null,
    false
  )
  const snapshot = { ...file, operationProvenance: provenance }
  store.setState({ openFiles: [{ ...snapshot, operationProvenance: structuredClone(provenance) }] })
  mocks.read.mockResolvedValue(linkResult)
  const result = mount()
  await act(() => result.current.load(snapshot))
  expect(result.current.contents.diff).toEqual(linkResult)
  expect(store.getState().openFiles[0]?.symbolicLink).toBe(true)
})
