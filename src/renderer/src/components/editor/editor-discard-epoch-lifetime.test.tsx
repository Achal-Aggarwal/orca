// @vitest-environment happy-dom
import type { Editor } from '@tiptap/react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { bumpEditorDiscardEpoch, editorDiscardEpoch } from './editor-discard-epoch'
import { staleViewEditEpoch } from './editor-stale-view-edit'
import { useRichMarkdownPendingSerialization } from './useRichMarkdownPendingSerialization'
import { useIpynbDocumentEditing } from './useIpynbDocumentEditing'
import { parseIpynb } from './ipynb-parse'

const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('@/store', () => {
  const store = () => {
    if (!storeRef.current) {
      throw new Error('store not set')
    }
    return storeRef.current
  }
  return {
    useAppStore: {
      getState: () => store().getState(),
      subscribe: (listener: Parameters<ReturnType<typeof createEditorStore>['subscribe']>[0]) =>
        store().subscribe(listener)
    }
  }
})

function openView(path: string) {
  const store = storeRef.current
  if (!store) {
    throw new Error('store not set')
  }
  store.getState().openFile({
    filePath: path,
    relativePath: path,
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit'
  })
  const file = store.getState().openFiles.find((view) => view.filePath === path)
  if (!file) {
    throw new Error('view not opened')
  }
  const recordId = store.getState().editorBufferIdOf[file.id]
  expect(recordId).not.toBe(file.id)
  return { file, recordId, store }
}

function renderRichView(fileId: string) {
  const onContentChange = vi.fn()
  const editorRef: { current: Editor | null } = { current: null }
  const refs = {
    fileId,
    editorRef,
    lastCommittedMarkdownRef: { current: 'saved' },
    originalSourceRef: { current: 'saved' },
    baseCanonicalRef: { current: 'saved' },
    onContentChangeRef: { current: onContentChange },
    reconcileRoundTripRef: { current: (markdown: string) => markdown }
  }
  const hook = renderHook(() => useRichMarkdownPendingSerialization(refs))
  const queueTyping = () => {
    hook.result.current.pendingEditEpochRef.current = staleViewEditEpoch(fileId)
    hook.result.current.serializeTimerRef.current = window.setTimeout(() => {}, 1000)
  }
  return { ...hook, queueTyping, onContentChange }
}

beforeEach(() => {
  vi.useFakeTimers()
  storeRef.current = createEditorStore()
  storeRef.current.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('releases epochs after distinct discarded rich views finish their final flush', () => {
  const retired: string[] = []
  for (let index = 0; index < 100; index += 1) {
    const { file, recordId, store } = openView(`/repo/discard-${index}.md`)
    const hook = renderRichView(file.id)
    hook.queueTyping()
    bumpEditorDiscardEpoch(recordId)
    hook.unmount()
    store.setState({ openFiles: [] })
    retired.push(recordId)
  }
  expect(retired.filter((recordId) => editorDiscardEpoch(recordId) !== 0)).toHaveLength(0)
})

it('keeps a discarded zero-epoch edit invalid through close and reopen before cleanup', () => {
  const { file, recordId, store } = openView('/repo/close-reopen.md')
  const oldView = renderRichView(file.id)
  oldView.queueTyping()
  bumpEditorDiscardEpoch(recordId)
  store.setState({ openFiles: [] })
  expect(oldView.result.current.flushPendingSerialization()).toBe(true)
  oldView.queueTyping()
  bumpEditorDiscardEpoch(recordId)
  const reopened = openView(file.filePath)
  const newView = renderRichView(reopened.file.id)
  oldView.unmount()
  expect(editorDiscardEpoch(recordId)).toBe(2)
  newView.queueTyping()
  expect(newView.result.current.flushPendingSerialization()).toBe(false)
  newView.unmount()
  expect(editorDiscardEpoch(recordId)).toBe(0)
})

it('preserves a surviving split view lease when another view unmounts', () => {
  const { file, recordId, store } = openView('/repo/split.md')
  const subscribed = vi.spyOn(store, 'subscribe')
  const first = renderRichView(file.id)
  const second = renderRichView(file.id)
  expect(subscribed.mock.calls.length).toBeLessThanOrEqual(1)
  second.queueTyping()
  bumpEditorDiscardEpoch(recordId)
  first.unmount()
  expect(second.result.current.flushPendingSerialization()).toBe(true)
  expect(editorDiscardEpoch(recordId)).toBe(1)
  second.unmount()
  expect(editorDiscardEpoch(recordId)).toBe(0)
})

it('drops notebook typing after discard and close, then releases its epoch on cleanup', () => {
  const { file, recordId, store } = openView('/repo/discard.ipynb')
  const content = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ id: 'a', cell_type: 'code', metadata: {}, source: ['saved'], outputs: [] }]
  })
  const onContentChange = vi.fn()
  const hook = renderHook(() =>
    useIpynbDocumentEditing({
      content,
      fileId: file.id,
      notebook: parseIpynb(content),
      onContentChange,
      onDirtyStateHint: () => {},
      onDeactivateEditor: () => {}
    })
  )
  act(() => hook.result.current.updateCellSource(0, 'discarded typing'))
  bumpEditorDiscardEpoch(recordId)
  store.setState({ openFiles: [] })
  act(() => {
    hook.result.current.flushSourceDrafts()
  })
  expect(onContentChange).toHaveBeenLastCalledWith(content)
  expect(hook.result.current.sourceDrafts).toEqual({})
  hook.unmount()
  expect(editorDiscardEpoch(recordId)).toBe(0)
})

it('moves view ownership to a rekeyed record and releases the retired identity', () => {
  const { file, recordId, store } = openView('/repo/before.md')
  const hook = renderRichView(file.id)
  bumpEditorDiscardEpoch(recordId)
  store.setState({ openFiles: [{ ...file, filePath: '/repo/after.md', relativePath: 'after.md' }] })
  const nextRecordId = store.getState().editorBufferIdOf[file.id]
  expect(nextRecordId).not.toBe(recordId)
  expect(editorDiscardEpoch(recordId)).toBe(0)
  hook.queueTyping()
  bumpEditorDiscardEpoch(nextRecordId)
  expect(hook.result.current.flushPendingSerialization()).toBe(true)
  hook.unmount()
  expect(editorDiscardEpoch(nextRecordId)).toBe(0)
})

it('allows current undiscarded rich typing to flush', () => {
  const { file } = openView('/repo/current.md')
  const hook = renderRichView(file.id)
  hook.queueTyping()
  expect(hook.result.current.flushPendingSerialization()).toBe(false)
  hook.unmount()
})

it('commits current notebook typing before its epoch is released', () => {
  const { file, recordId } = openView('/repo/current.ipynb')
  const content = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ id: 'a', cell_type: 'code', metadata: {}, source: ['saved'], outputs: [] }]
  })
  const onContentChange = vi.fn()
  const hook = renderHook(() =>
    useIpynbDocumentEditing({
      content,
      fileId: file.id,
      notebook: parseIpynb(content),
      onContentChange,
      onDirtyStateHint: () => {},
      onDeactivateEditor: () => {}
    })
  )
  act(() => hook.result.current.updateCellSource(0, 'current typing'))
  act(() => {
    hook.result.current.flushSourceDrafts()
  })
  const emitted = onContentChange.mock.lastCall?.[0]
  expect(typeof emitted).toBe('string')
  expect(parseIpynb(emitted ?? '').cells[0]?.source).toBe('current typing')
  hook.unmount()
  expect(editorDiscardEpoch(recordId)).toBe(0)
})
