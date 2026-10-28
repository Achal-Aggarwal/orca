// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMonacoEditorInputBindings } from './monaco-editor-input-bindings'
import { isEditorLargePasteInFlight } from './editor-large-paste-in-flight'
import { runOrcaContextMenuPaste } from './monaco-context-menu-paste'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./editor-shortcuts', () => ({
  installEditorSaveShortcut: () => vi.fn(),
  installMonacoEditorFindShortcut: () => vi.fn(),
  installEditorAddReviewNoteShortcut: () => vi.fn()
}))

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

describe.each(['dom', 'menu'] as const)('%s paste lifecycle', (route) => {
  it.each(['detached', 'reassigned', 'disposed', 'completed', 'throwing'] as const)(
    'preserves the admitted paste model and publisher through %s',
    async (transition) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const originalModel = monaco.editor.createModel('original')
      const successorModel = monaco.editor.createModel('successor')
      let liveModel: editor.ITextModel | null = originalModel
      let focused = true
      let selections = [
        monaco.Selection.fromRange(
          originalModel.getFullModelRange().collapseToEnd(),
          monaco.SelectionDirection.LTR
        )
      ]
      const node = document.createElement('div')
      document.body.append(node)
      const getValue = vi.fn(() => liveModel?.getValue() ?? '')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the input binding and paste executor use these real model, selection, action, and DOM methods.
      const instance = {
        getModel: () => liveModel,
        getValue,
        getOption: () => false,
        trigger: vi.fn(),
        getContainerDomNode: () => node,
        hasTextFocus: () => focused,
        getSelection: () => selections[0],
        getSelections: () => selections,
        setSelection: (next: monaco.IRange) => {
          selections = [
            monaco.Selection.fromRange(monaco.Range.lift(next), monaco.SelectionDirection.LTR)
          ]
        },
        executeEdits: (
          _source: string,
          edits: editor.IIdentifiedSingleEditOperation[],
          cursorState?: editor.ICursorStateComputer | monaco.Selection[]
        ) => {
          if (transition === 'throwing' && changes === 3) {
            throw new Error('paste edit failed')
          }
          const next = liveModel?.pushEditOperations(selections, edits, (inverse) =>
            typeof cursorState === 'function' ? cursorState(inverse) : (cursorState ?? null)
          )
          if (next) {
            selections = next
          }
          return true
        },
        pushUndoStop: () => {
          liveModel?.pushStackElement()
          return true
        },
        addAction: () => ({ dispose: vi.fn() })
      } as unknown as editor.IStandaloneCodeEditor
      const originalPublisher = vi.fn()
      const successorPublisher = vi.fn()
      const propsRef = {
        current: {
          relativePath: 'original.txt',
          language: 'plaintext',
          onSave: vi.fn(),
          onContentChange: originalPublisher
        }
      }
      const lastSyncedContentRef = { current: 'original' }
      const isApplyingLargePasteRef = { current: false }
      const binding = installMonacoEditorInputBindings({
        editorInstance: instance,
        worktreeId: undefined,
        editorContainerRef: { current: node },
        propsRef,
        readOnlyRef: { current: false },
        lastSyncedContentRef,
        isApplyingLargePasteRef,
        commentPopoverRef: { current: null },
        shouldShowMarkdownAnnotationsRef: { current: false },
        setCommentPopover: vi.fn(),
        setSelectionAnnotationTarget: vi.fn()
      })
      let changes = 0
      const inFlightStates: boolean[] = []
      const subscription = originalModel.onDidChangeContent(() => {
        changes++
        inFlightStates.push(
          isApplyingLargePasteRef.current &&
            isEditorLargePasteInFlight(originalModel.uri.toString())
        )
        if (transition === 'completed' || transition === 'throwing' || changes !== 3) {
          return
        }
        focused = false
        liveModel = transition === 'reassigned' ? successorModel : null
        propsRef.current.onContentChange = successorPublisher
        if (transition === 'disposed') {
          originalModel.dispose()
        }
      })
      const data = new DataTransfer()
      data.setData('text/plain', 'paste row\n'.repeat(10_000))
      const event = new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
      try {
        const runMenuPaste = () => {
          const pending = runOrcaContextMenuPaste({
            getFocusedEditor: () => instance,
            readClipboardText: async () => data.getData('text/plain'),
            getClipboardMetadata: () => null,
            emptySelectionClipboardOptionId: monaco.editor.EditorOption.emptySelectionClipboard,
            readOnlyOptionId: monaco.editor.EditorOption.readOnly
          })
          if (!pending) {
            throw new Error('Expected menu command ownership')
          }
          return pending
        }
        if (route === 'menu') {
          await (transition === 'throwing'
            ? expect(runMenuPaste()).rejects.toThrow('paste edit failed')
            : runMenuPaste())
        } else {
          node.dispatchEvent(event)
          expect(event.defaultPrevented).toBe(true)
        }
        await vi.waitFor(() => {
          expect(isApplyingLargePasteRef.current).toBe(false)
          expect(isEditorLargePasteInFlight(originalModel.uri.toString())).toBe(false)
        })
        expect(inFlightStates.length).toBeGreaterThan(0)
        expect(inFlightStates.every(Boolean)).toBe(true)
        if (transition === 'completed' || transition === 'throwing') {
          expect(changes).toBe(transition === 'completed' ? 7 : 3)
          expect(originalPublisher).toHaveBeenCalledExactlyOnceWith(originalModel.getValue())
          expect(lastSyncedContentRef.current).toBe(originalModel.getValue())
          originalModel.undo()
          expect(originalModel.getValue()).toBe('original')
          if (transition === 'completed' && route === 'menu') {
            originalPublisher.mockClear()
            inFlightStates.length = 0
            binding.disposeInputBindings()
            await runMenuPaste()
            expect(inFlightStates.every((value) => !value)).toBe(true)
            expect(originalPublisher).not.toHaveBeenCalled()
          }
          expect(consoleError).toHaveBeenCalledTimes(
            transition === 'throwing' && route === 'dom' ? 1 : 0
          )
          return
        }
        expect(changes).toBe(3)
        expect(getValue).not.toHaveBeenCalled()
        expect(successorPublisher).not.toHaveBeenCalled()
        expect(successorModel.getValue()).toBe('successor')
        expect(lastSyncedContentRef.current).toBe('original')
        if (transition === 'disposed') {
          expect(originalPublisher).not.toHaveBeenCalled()
        } else {
          expect(originalPublisher).toHaveBeenCalledExactlyOnceWith(originalModel.getValue())
          expect(originalModel.getValueLength()).toBeGreaterThan('original'.length)
          originalModel.undo()
          expect(originalModel.getValue()).toBe('original')
        }
      } finally {
        subscription.dispose()
        binding.disposeInputBindings()
      }
    }
  )
})
