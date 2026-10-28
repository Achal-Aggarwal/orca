// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import type * as MonacoApi from 'monaco-editor'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DiffViewer from './DiffViewer'
import { DiffSectionItem } from './DiffSectionItem'
import type { DiffSection } from './diff-section-types'
import { executeMonacoLargeTextPaste } from './monaco-large-text-paste'

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

function createDiffEditor(node: HTMLElement) {
  let pair: editor.IDiffEditorModel | null = null
  let modelSubscription: monaco.IDisposable | null = null
  const contentListeners = new Set<() => void>()
  const disposals = new Set<() => void>()
  let selections = [new monaco.Selection(1, 1, 1, 1)]
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
    hasTextFocus: () => true,
    getSelection: () => selections[0],
    getSelections: () => selections,
    setSelection: (range: monaco.IRange | monaco.ISelection) => {
      selections = [
        'startLineNumber' in range
          ? monaco.Selection.fromRange(monaco.Range.lift(range), monaco.SelectionDirection.LTR)
          : new monaco.Selection(
              range.selectionStartLineNumber,
              range.selectionStartColumn,
              range.positionLineNumber,
              range.positionColumn
            )
      ]
    },
    getContentHeight: () => 120,
    onDidContentSizeChange: () => ({ dispose: vi.fn() }),
    getContainerDomNode: () => node,
    getOption: () => false,
    executeEdits: (
      _source: string | undefined,
      edits: editor.IIdentifiedSingleEditOperation[],
      cursorState?: editor.ICursorStateComputer | monaco.Selection[]
    ) => {
      const next = pair?.modified.pushEditOperations(selections, edits, (inverse) =>
        typeof cursorState === 'function' ? cursorState(inverse) : (cursorState ?? null)
      )
      if (next) {
        selections = next
      }
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
      getContainerDomNode: () => node,
      getModel: () => pair?.original ?? null,
      setModel: (model: editor.ITextModel) => {
        if (pair) {
          setPair({ ...pair, original: model })
        }
      }
    }),
    getContainerDomNode: () => node,
    getLineChanges: () => null,
    onDidUpdateDiff: () => ({ dispose: vi.fn() }),
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
  return { diff, modified, getValue, contentListeners }
}

vi.mock('./useDiffSectionLayoutMetrics', () => ({
  useDiffSectionLayoutMetrics: () => ({
    lineStats: { added: 0, removed: 0 },
    sectionBodyHeight: 120,
    useIntrinsicImageHeight: false,
    isLargeDiffLimited: false
  })
}))
vi.mock('./use-diff-section-model-lifecycle', () => ({
  useDiffSectionModelLifecycle: () => ({ disposeDiffModels: vi.fn(), setSectionRootNode: vi.fn() })
}))
vi.mock('./useDiffSectionFallbackCleanup', () => ({ useDiffSectionFallbackCleanup: vi.fn() }))
vi.mock('./DiffSectionHeader', () => ({ DiffSectionHeader: () => null }))

let instance: ReturnType<typeof createDiffEditor>
const instances: ReturnType<typeof createDiffEditor>[] = []
beforeEach(() => {
  instances.length = 0
  const api = {
    ...monaco,
    editor: {
      ...monaco.editor,
      createDiffEditor: (node: HTMLElement) => {
        instance = createDiffEditor(node)
        instances.push(instance)
        return instance.diff
      },
      setTheme: vi.fn()
    }
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

function renderSurface(kind: 'file' | 'combined', key = 'one') {
  let mounted = true
  let sections: DiffSection[] = [
    {
      key,
      path: 'file.txt',
      status: 'M',
      area: 'unstaged',
      originalContent: 'original',
      modifiedContent: 'initial',
      collapsed: false,
      loading: false,
      dirty: false,
      diffResult: {
        kind: 'text',
        originalContent: 'original',
        modifiedContent: 'initial',
        originalIsBinary: false,
        modifiedIsBinary: false
      },
      largeDiffRenderLimit: null
    }
  ]
  const publish = vi.fn()
  const element = (content = 'initial') =>
    kind === 'file' ? (
      <DiffViewer
        modelKey={`paste-file-${key}`}
        originalContent="original"
        modifiedContent={content}
        language="plaintext"
        filePath="/repo/file.txt"
        relativePath="file.txt"
        sideBySide
        editable
        onContentChange={(next) => {
          publish(next)
          if (mounted) {
            view.rerender(element(next))
          }
        }}
      />
    ) : (
      <DiffSectionItem
        section={sections[0]}
        index={0}
        isBranchMode={false}
        sideBySide
        isDark={false}
        settings={null}
        sectionHeight={120}
        loadSection={vi.fn()}
        retrySection={vi.fn()}
        toggleSection={vi.fn()}
        openSection={vi.fn()}
        openSectionTitle="Open"
        setSectionHeights={vi.fn()}
        setSections={(next) => {
          sections = typeof next === 'function' ? next(sections) : next
          publish(sections[0].modifiedContent)
          if (mounted) {
            view.rerender(element())
          }
        }}
        modifiedEditorsRef={{ current: new Map() }}
        handleSectionSaveRef={{ current: async () => {} }}
      />
    )
  const view = render(element())
  return {
    publish,
    view,
    retire: () => {
      mounted = false
      view.unmount()
    }
  }
}

it.each(['file', 'combined'] as const)(
  'publishes %s menu paste only at completion and preserves Undo/Redo',
  async (kind) => {
    const f = renderSurface(kind)
    await vi.waitFor(() => expect(instance.contentListeners.size).toBe(1))
    const model = instance.modified.getModel()
    if (!model) {
      throw new Error('Missing modified model')
    }
    instance.modified.setSelection(
      monaco.Range.fromPositions(model.getPositionAt(model.getValueLength()))
    )
    const reads = vi.spyOn(model, 'getValue')
    const text = 'paste row\n'.repeat(10_000)
    let yields = 0
    let result
    await act(async () => {
      result = await executeMonacoLargeTextPaste(instance.modified, text, {
        measureYieldAfterCodeUnits: 1_000_000,
        yieldToEventLoop: async () => {
          yields++
          expect(f.publish).not.toHaveBeenCalled()
        }
      })
    })
    expect(result).toMatchObject({ status: 'pasted' })
    expect(yields).toBeGreaterThan(1)
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(`initial${text}`)
    expect(reads.mock.calls.length).toBeLessThanOrEqual(2)
    act(() => model.undo())
    expect(f.publish).toHaveBeenLastCalledWith('initial')
    act(() => model.redo())
    expect(f.publish).toHaveBeenLastCalledWith(`initial${text}`)
    f.retire()
    f.publish.mockClear()
    act(() => model.setValue('after close'))
    expect(f.publish).not.toHaveBeenCalled()
  }
)

it.each(['file', 'combined'] as const)(
  'settles the original %s owner when its widget retires mid-paste',
  async (kind) => {
    const f = renderSurface(kind)
    await vi.waitFor(() => expect(instance.contentListeners.size).toBe(1))
    const model = instance.modified.getModel()
    if (!model) {
      throw new Error('Missing modified model')
    }
    const owner = instance.modified
    owner.setSelection(monaco.Range.fromPositions(model.getPositionAt(model.getValueLength())))
    let yields = 0
    let result
    await act(async () => {
      result = await executeMonacoLargeTextPaste(owner, 'x'.repeat(100_000), {
        measureYieldAfterCodeUnits: 1_000_000,
        yieldToEventLoop: async () => {
          if (++yields === 2) {
            f.retire()
          }
        }
      })
    })
    expect(result).toMatchObject({ status: 'cancelled', chunksWritten: 2 })
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(`initial${'x'.repeat(32_768)}`)
    model.undo()
    expect(model.getValue()).toBe('initial')
  }
)

it.each(['file', 'combined'] as const)(
  'retains every distinct %s publisher across ten shared-model panes',
  async (kind) => {
    const views = Array.from({ length: 10 }, () => renderSurface(kind))
    await vi.waitFor(() => expect(instances).toHaveLength(10))
    await vi.waitFor(() =>
      expect(instances.every((entry) => entry.contentListeners.size === 1)).toBe(true)
    )
    const model = instance.modified.getModel()
    if (!model) {
      throw new Error('Missing shared model')
    }
    expect(instances.every((entry) => entry.modified.getModel() === model)).toBe(true)
    instance.modified.setSelection(
      monaco.Range.fromPositions(model.getPositionAt(model.getValueLength()))
    )
    const reads = vi.spyOn(model, 'getValue')
    await act(async () => {
      await executeMonacoLargeTextPaste(instance.modified, 'x'.repeat(100_000), {
        measureYieldAfterCodeUnits: 1_000_000,
        yieldToEventLoop: async () => {
          views.forEach((f) => expect(f.publish).not.toHaveBeenCalled())
        }
      })
    })
    views.forEach((f) =>
      expect(f.publish).toHaveBeenCalledExactlyOnceWith(`initial${'x'.repeat(100_000)}`)
    )
    expect(reads.mock.calls.length).toBeLessThanOrEqual(11)
  }
)

it.each(['file', 'combined'] as const)(
  'releases %s publication after a throwing executor and retains the accepted prefix',
  async (kind) => {
    const f = renderSurface(kind)
    await vi.waitFor(() => expect(instance.contentListeners.size).toBe(1))
    const model = instance.modified.getModel()
    if (!model) {
      throw new Error('Missing modified model')
    }
    instance.modified.setSelection(
      monaco.Range.fromPositions(model.getPositionAt(model.getValueLength()))
    )
    const execute = instance.modified.executeEdits
    let calls = 0
    instance.modified.executeEdits = (...args) => {
      if (++calls === 2) {
        throw new Error('Execution failed')
      }
      return execute(...args)
    }
    await act(async () => {
      await expect(
        executeMonacoLargeTextPaste(instance.modified, 'x'.repeat(100_000), {
          measureYieldAfterCodeUnits: 1_000_000,
          yieldToEventLoop: async () => {}
        })
      ).rejects.toThrow('Execution failed')
    })
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(`initial${'x'.repeat(16_384)}`)
    act(() =>
      model.pushEditOperations(
        [],
        [{ range: new monaco.Range(1, 1, 1, 1), text: 'after' }],
        () => null
      )
    )
    expect(f.publish).toHaveBeenCalledTimes(2)
  }
)

it('does not defer a distinct actual model while another pane pastes', async () => {
  const first = renderSurface('file', 'first')
  const second = renderSurface('file', 'second')
  await vi.waitFor(() => expect(instances).toHaveLength(2))
  await vi.waitFor(() =>
    expect(instances.every((entry) => entry.contentListeners.size === 1)).toBe(true)
  )
  const owner = instances[0].modified
  const firstModel = owner.getModel(),
    secondModel = instances[1].modified.getModel()
  if (!firstModel || !secondModel) {
    throw new Error('Missing distinct models')
  }
  expect(firstModel).not.toBe(secondModel)
  owner.setSelection(
    monaco.Range.fromPositions(firstModel.getPositionAt(firstModel.getValueLength()))
  )
  let edited = false
  await act(async () => {
    await executeMonacoLargeTextPaste(owner, 'x'.repeat(100_000), {
      measureYieldAfterCodeUnits: 1_000_000,
      yieldToEventLoop: async () => {
        if (!edited) {
          edited = true
          secondModel.pushEditOperations(
            [],
            [{ range: secondModel.getFullModelRange(), text: 'independent' }],
            () => null
          )
          expect(second.publish).toHaveBeenCalledExactlyOnceWith('independent')
          expect(first.publish).not.toHaveBeenCalled()
        }
      }
    })
  })
  expect(first.publish).toHaveBeenCalledOnce()
})
