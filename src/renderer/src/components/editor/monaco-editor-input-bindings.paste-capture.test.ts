// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { installMonacoEditorInputBindings } from './monaco-editor-input-bindings'
import { MONACO_PASTE_MAX_BYTES } from './monaco-large-text-paste'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./editor-shortcuts', () => ({
  installEditorSaveShortcut: () => vi.fn(),
  installMonacoEditorFindShortcut: () => vi.fn(),
  installEditorAddReviewNoteShortcut: () => vi.fn()
}))

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

function fixture(readOnly = false) {
  const shell = document.createElement('div')
  const node = document.createElement('div')
  const input = document.createElement('textarea')
  const commentInput = document.createElement('textarea')
  node.append(input)
  shell.append(node, commentInput)
  document.body.append(shell)
  const model = monaco.editor.createModel('base')
  let selections = [new monaco.Selection(1, 5, 1, 5)]
  const nativePaste = vi.fn((event: ClipboardEvent) => {
    event.preventDefault()
    event.stopImmediatePropagation()
  })
  node.addEventListener('paste', nativePaste, { capture: true })
  const executeEdits = vi.fn(
    (
      _source: string,
      edits: editor.IIdentifiedSingleEditOperation[],
      cursorState?: editor.ICursorStateComputer | monaco.Selection[]
    ) => {
      const next = model.pushEditOperations(selections, edits, (inverse) =>
        typeof cursorState === 'function' ? cursorState(inverse) : (cursorState ?? null)
      )
      if (next) {
        selections = next
      }
      return true
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the binding and paste executor use the real model, selection, edit, action, and DOM methods below.
  const instance = {
    getModel: () => model,
    getValue: () => model.getValue(),
    getContainerDomNode: () => node,
    hasTextFocus: () => true,
    getSelection: () => selections[0],
    getSelections: () => selections,
    setSelection: (range: monaco.IRange) => {
      selections = [
        monaco.Selection.fromRange(monaco.Range.lift(range), monaco.SelectionDirection.LTR)
      ]
    },
    executeEdits,
    pushUndoStop: () => {
      model.pushStackElement()
      return true
    },
    addAction: () => ({ dispose: vi.fn() })
  } as unknown as editor.IStandaloneCodeEditor
  const onContentChange = vi.fn()
  const isApplyingLargePasteRef = { current: false }
  const binding = installMonacoEditorInputBindings({
    editorInstance: instance,
    worktreeId: undefined,
    editorContainerRef: { current: shell },
    propsRef: {
      current: {
        relativePath: 'paste.txt',
        language: 'plaintext',
        onSave: vi.fn(),
        onContentChange
      }
    },
    readOnlyRef: { current: readOnly },
    lastSyncedContentRef: { current: 'base' },
    isApplyingLargePasteRef,
    commentPopoverRef: { current: null },
    shouldShowMarkdownAnnotationsRef: { current: false },
    setCommentPopover: vi.fn(),
    setSelectionAnnotationTarget: vi.fn()
  })
  const paste = (text: string, target: HTMLElement = input) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    data.setData('vscode-editor-data', '{"isFromEmptySelection":true}')
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data
    })
    target.dispatchEvent(event)
    return event
  }
  return {
    model,
    commentInput,
    nativePaste,
    executeEdits,
    onContentChange,
    isApplyingLargePasteRef,
    binding,
    paste
  }
}

it('rejects over-limit paste before an earlier Monaco capture handler can claim it', async () => {
  const f = fixture()
  const event = f.paste('x'.repeat(MONACO_PASTE_MAX_BYTES + 1))
  expect(event.defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Paste is too large.'))
  expect(f.nativePaste).not.toHaveBeenCalled()
  expect(f.executeEdits).not.toHaveBeenCalled()
  expect(f.onContentChange).not.toHaveBeenCalled()
  expect(f.model.getValue()).toBe('base')
  expect(f.isApplyingLargePasteRef.current).toBe(false)
  f.binding.disposeInputBindings()
})

it('chunks admitted large paste before Monaco and retains the final draft and single Undo', async () => {
  const f = fixture()
  const text = 'paste row\n'.repeat(10_000)
  expect(f.paste(text).defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(f.onContentChange).toHaveBeenCalledExactlyOnceWith(`base${text}`))
  expect(f.nativePaste).not.toHaveBeenCalled()
  expect(f.executeEdits.mock.calls.length).toBeGreaterThan(1)
  expect(f.isApplyingLargePasteRef.current).toBe(false)
  f.model.undo()
  expect(f.model.getValue()).toBe('base')
  f.binding.disposeInputBindings()
})

it.each(['small', 'read-only', 'disposed'] as const)(
  'retains Monaco ownership and clipboard metadata for %s paste',
  (mode) => {
    const f = fixture(mode === 'read-only')
    if (mode === 'disposed') {
      f.binding.disposeInputBindings()
    }
    const event = f.paste(mode === 'small' ? 'native' : 'x'.repeat(70_000))
    expect(f.nativePaste).toHaveBeenCalledExactlyOnceWith(event)
    expect(event.clipboardData?.getData('vscode-editor-data')).toBe('{"isFromEmptySelection":true}')
    expect(f.executeEdits).not.toHaveBeenCalled()
    expect(f.onContentChange).not.toHaveBeenCalled()
    f.binding.disposeInputBindings()
  }
)

it('leaves comment-overlay input paste outside the editor route', () => {
  const f = fixture()
  expect(f.paste('x'.repeat(70_000), f.commentInput).defaultPrevented).toBe(false)
  expect(f.nativePaste).not.toHaveBeenCalled()
  expect(f.executeEdits).not.toHaveBeenCalled()
  expect(f.onContentChange).not.toHaveBeenCalled()
  expect(f.model.getValue()).toBe('base')
  f.binding.disposeInputBindings()
})
