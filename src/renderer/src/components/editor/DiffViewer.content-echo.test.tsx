// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import type * as MonacoApi from 'monaco-editor'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DiffViewer from './DiffViewer'

const fixture = vi.hoisted(() => {
  return {
    state: { settings: {}, editorFontZoomLevel: 0 },
    registerDiffEditor: vi.fn(),
    unregisterDiffEditor: vi.fn()
  }
})
vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: typeof fixture.state) => T) => selector(fixture.state)
}))
vi.mock('@/store/worktree-diff-comments-selector', () => ({
  selectWorktreeDiffComments: () => undefined
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: vi.fn(), toastNode: null })
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({ useDiffCommentDecorator: vi.fn() }))
vi.mock('./useDiffViewerFirstChangeAutoScroll', () => ({
  useDiffViewerFirstChangeAutoScroll: vi.fn()
}))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
vi.mock('./diff-editor-line-number-options', () => ({
  applyDiffEditorLineNumberOptions: () => ({ dispose: vi.fn() })
}))
vi.mock('./diff-editor-word-wrap-options', () => ({
  buildDiffEditorWordWrapOptions: () => ({}),
  syncDiffEditorOriginalWordWrap: () => ({ dispose: vi.fn() })
}))
vi.mock('./diff-model-swap-view-state', () => ({
  preserveDiffViewStateAcrossModelSwaps: () => ({ dispose: vi.fn() })
}))
vi.mock('./editor-shortcuts', () => ({
  installEditorSaveShortcut: () => vi.fn(),
  installMonacoEditorFindShortcut: () => vi.fn()
}))
vi.mock('./diff-navigation-context', () => ({
  useDiffEditorRegistration: () => ({
    registerDiffEditor: fixture.registerDiffEditor,
    unregisterDiffEditor: fixture.unregisterDiffEditor
  })
}))
vi.mock('./useDiffViewerLargeDiffLifecycle', () => ({
  useDiffViewerLargeDiffLifecycle: ({ modelKey }: { modelKey: string }) => ({
    originalModelPath: `${modelKey}-original`,
    modifiedModelPath: `${modelKey}-modified`
  })
}))

function createDiffEditor() {
  let pair: editor.IDiffEditorModel | null = null
  let modelSubscription: monaco.IDisposable | null = null
  const contentListeners = new Set<() => void>()
  const disposals = new Set<() => void>()
  const node = document.createElement('div')
  const setPair = (next: editor.IDiffEditorModel): void => {
    pair = next
    modelSubscription?.dispose()
    modelSubscription = next.modified.onDidChangeContent(() => {
      for (const listener of contentListeners) {
        listener()
      }
    })
  }
  const getValue = vi.fn(() => pair?.modified.getValue() ?? '')
  const modified = {
    getModel: () => pair?.modified ?? null,
    setModel: (model: editor.ITextModel) => {
      if (pair) {
        setPair({ ...pair, modified: model })
      }
    },
    getValue,
    getContainerDomNode: () => node,
    getOption: () => false,
    executeEdits: (_source: string, edits: editor.IIdentifiedSingleEditOperation[]) => {
      pair?.modified.pushEditOperations([], edits, () => null)
      return true
    },
    pushUndoStop: () => {
      pair?.modified.pushStackElement()
      return true
    },
    onDidChangeModelContent: (listener: () => void) => {
      contentListeners.add(listener)
      return { dispose: () => contentListeners.delete(listener) }
    },
    onDidDispose: (listener: () => void) => {
      disposals.add(listener)
      return { dispose: () => disposals.delete(listener) }
    },
    focus: vi.fn()
  }
  const diff = {
    getModel: () => pair,
    setModel: setPair,
    getModifiedEditor: () => modified,
    getOriginalEditor: () => ({
      getModel: () => pair?.original ?? null,
      setModel: (model: editor.ITextModel) => {
        if (pair) {
          setPair({ ...pair, original: model })
        }
      }
    }),
    onDidDispose: (listener: () => void) => {
      disposals.add(listener)
      return { dispose: () => disposals.delete(listener) }
    },
    updateOptions: vi.fn(),
    saveViewState: () => null,
    dispose: () => {
      for (const listener of disposals) {
        listener()
      }
      modelSubscription?.dispose()
    }
  }
  return { diff, getValue, contentListeners }
}

let instance: ReturnType<typeof createDiffEditor>
beforeEach(() => {
  instance = createDiffEditor()
  const api = {
    ...monaco,
    editor: { ...monaco.editor, createDiffEditor: () => instance.diff, setTheme: vi.fn() }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real wrapper uses this real-model API and the diff widget methods implemented by the fixture.
  loader.config({ monaco: api as unknown as typeof MonacoApi })
})
afterEach(() => {
  cleanup()
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

function element(content: string, onContentChange?: (content: string) => void, modelKey = 'echo') {
  return (
    <DiffViewer
      modelKey={modelKey}
      originalContent="original"
      modifiedContent={content}
      language="plaintext"
      filePath="/repo/file.txt"
      relativePath="file.txt"
      sideBySide
      editable
      onContentChange={onContentChange}
    />
  )
}

it('skips the controlled-prop equality read for its own edit, Undo and Redo echoes', async () => {
  const publish = vi.fn((content: string) => view.rerender(element(content, publish)))
  const view = render(element('initial', publish))
  await vi.waitFor(() => expect(instance.contentListeners.size).toBe(1))
  instance.getValue.mockClear()
  const model = instance.diff.getModel()?.modified
  if (!model) {
    throw new Error('Missing modified model')
  }
  act(() =>
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: 'typed' }], () => null)
  )
  expect(instance.getValue).toHaveBeenCalledOnce()
  expect(publish).toHaveBeenLastCalledWith('typed')

  instance.getValue.mockClear()
  act(() => model.undo())
  expect(instance.getValue).toHaveBeenCalledOnce()
  expect(publish).toHaveBeenLastCalledWith('initial')
  instance.getValue.mockClear()
  act(() => model.redo())
  expect(instance.getValue).toHaveBeenCalledOnce()
  expect(publish).toHaveBeenLastCalledWith('typed')

  view.rerender(element('initial', publish))
  expect(model.getValue()).toBe('initial')
  view.rerender(element('external', publish))
  expect(model.getValue()).toBe('external')
  view.rerender(element('replacement', publish, 'successor'))
  expect(instance.diff.getModel()?.modified).not.toBe(model)
  expect(instance.diff.getModel()?.modified.getValue()).toBe('replacement')

  view.unmount()
  expect(instance.contentListeners.size).toBe(0)
  instance.getValue.mockClear()
  model.setValue('after close')
  expect(instance.getValue).not.toHaveBeenCalled()
})

it('does not read model events without a content observer', async () => {
  render(element('initial'))
  await vi.waitFor(() => expect(instance.contentListeners.size).toBe(1))
  instance.getValue.mockClear()
  act(() => instance.diff.getModel()?.modified.setValue('unobserved'))
  expect(instance.getValue).not.toHaveBeenCalled()
})
