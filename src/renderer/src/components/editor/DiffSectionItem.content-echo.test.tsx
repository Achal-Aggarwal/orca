// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import type * as MonacoApi from 'monaco-editor'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState, type Dispatch, type SetStateAction } from 'react'
import { DiffSectionItem } from './DiffSectionItem'
import type { DiffSection } from './diff-section-types'

const fixture = vi.hoisted(() => {
  return {
    state: { editorFontZoomLevel: 0, setScrollToDiffCommentId: vi.fn() }
  }
})
vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: typeof fixture.state) => T) => selector(fixture.state)
}))
vi.mock('@/store/worktree-diff-comments-selector', () => ({
  selectWorktreeDiffComments: () => undefined
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({ useDiffCommentDecorator: vi.fn() }))
vi.mock('./DiffSectionHeader', () => ({ DiffSectionHeader: () => null }))
vi.mock('./use-diff-section-model-lifecycle', () => ({
  useDiffSectionModelLifecycle: () => ({ disposeDiffModels: vi.fn(), setSectionRootNode: vi.fn() })
}))
vi.mock('./useDiffSectionLayoutMetrics', () => ({
  useDiffSectionLayoutMetrics: () => ({ sectionBodyHeight: 300, isLargeDiffLimited: false })
}))
vi.mock('./useDiffSectionFallbackCleanup', () => ({ useDiffSectionFallbackCleanup: vi.fn() }))
vi.mock('./diff-editor-shift-wheel-scroll', () => ({
  installDiffEditorShiftWheelScroll: () => vi.fn()
}))
vi.mock('./diff-editor-line-number-options', () => ({
  applyDiffEditorLineNumberOptions: () => ({ dispose: vi.fn() })
}))
vi.mock('./diff-editor-word-wrap-options', () => ({
  buildDiffEditorWordWrapOptions: () => ({}),
  syncDiffEditorOriginalWordWrap: () => ({ dispose: vi.fn() })
}))
vi.mock('./editor-shortcuts', () => ({
  installEditorSaveShortcut: () => vi.fn(),
  installMonacoEditorFindShortcut: () => vi.fn()
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
    getContentHeight: () => 300,
    onDidContentSizeChange: () => ({ dispose: vi.fn() }),
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
    getContainerDomNode: () => node,
    getLineChanges: () => null,
    onDidUpdateDiff: () => ({ dispose: vi.fn() }),
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

let instances: ReturnType<typeof createDiffEditor>[]
beforeEach(() => {
  instances = []
  const api = {
    ...monaco,
    editor: {
      ...monaco.editor,
      createDiffEditor: () => {
        const instance = createDiffEditor()
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

function section(key = 'editable', content = 'initial'): DiffSection {
  return {
    key,
    path: `${key}.txt`,
    status: 'modified',
    area: 'unstaged',
    originalContent: 'original',
    modifiedContent: content,
    collapsed: false,
    loading: false,
    dirty: false,
    diffResult: {
      kind: 'text',
      originalContent: 'original',
      modifiedContent: content,
      originalIsBinary: false,
      modifiedIsBinary: false
    },
    largeDiffRenderLimit: null
  }
}

function mountSections(initial: DiffSection[]) {
  let current = initial
  let update: Dispatch<SetStateAction<DiffSection[]>> = () => {
    throw new Error('Not mounted')
  }
  const modifiedEditorsRef = { current: new Map<number, editor.IStandaloneCodeEditor>() }
  const save = vi.fn(async () => {})
  const noop = () => {}
  function Harness() {
    const [sections, setSections] = useState(initial)
    current = sections
    update = setSections
    return sections.map((value, index) => (
      <DiffSectionItem
        key={value.key}
        section={value}
        index={index}
        isBranchMode={false}
        sideBySide
        isDark={false}
        settings={null}
        sectionHeight={300}
        loadSection={noop}
        retrySection={noop}
        toggleSection={noop}
        openSection={noop}
        openSectionTitle="Open"
        setSectionHeights={noop}
        setSections={setSections}
        modifiedEditorsRef={modifiedEditorsRef}
        handleSectionSaveRef={{ current: save }}
      />
    ))
  }
  const view = render(<Harness />)
  return {
    ...view,
    sections: () => current,
    update: (fn: (prev: DiffSection[]) => DiffSection[]) => act(() => update(fn)),
    modifiedEditorsRef
  }
}

function modifiedModel(index = 0) {
  const model = instances[index]?.diff.getModel()?.modified
  if (!model) {
    throw new Error('Missing modified model')
  }
  return model
}

it.each([1000, 10000])(
  'publishes edits, Undo and Redo once without a wrapper echo read at %i lines',
  async (lines) => {
    const initial = 'unchanged line\n'.repeat(lines)
    const view = mountSections([section('edited', initial), section('sibling', initial)])
    await vi.waitFor(() => expect(instances).toHaveLength(2))
    await vi.waitFor(() => expect(instances[0].contentListeners.size).toBe(1))
    for (const instance of instances) {
      instance.getValue.mockClear()
    }
    const model = modifiedModel()
    const edit = { range: new monaco.Range(1, 1, 1, 1), text: 'typed ' }
    act(() => model.pushEditOperations([], [edit], () => null))
    expect(instances[0].getValue).toHaveBeenCalledOnce()
    expect(instances[1].getValue).not.toHaveBeenCalled()
    expect(view.sections()[0].modifiedContent).toBe(`typed ${initial}`)
    expect(view.sections()[0].dirty).toBe(true)
    expect(view.sections()[1].modifiedContent).toBe(initial)

    instances[0].getValue.mockClear()
    act(() => model.undo())
    expect(instances[0].getValue).toHaveBeenCalledOnce()
    expect(view.sections()[0].modifiedContent).toBe(initial)
    expect(view.sections()[0].dirty).toBe(false)
    instances[0].getValue.mockClear()
    act(() => model.redo())
    expect(instances[0].getValue).toHaveBeenCalledOnce()
    expect(view.sections()[0].modifiedContent).toBe(`typed ${initial}`)
  }
)

it('reconciles external resets including the held wrapper prop and replacement generations', async () => {
  const view = mountSections([section()])
  await vi.waitFor(() => expect(instances[0]?.contentListeners.size).toBe(1))
  const model = modifiedModel()
  act(() =>
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: 'typed' }], () => null)
  )
  view.update((prev) => prev.map((s) => ({ ...s, modifiedContent: 'initial' })))
  expect(model.getValue()).toBe('initial')
  expect(view.sections()[0].dirty).toBe(false)
  act(() => model.undo())
  expect(model.getValue()).toBe('typed')
  expect(view.sections()[0].dirty).toBe(true)
  act(() => model.redo())
  expect(model.getValue()).toBe('initial')
  expect(view.sections()[0].dirty).toBe(false)
  view.update((prev) => prev.map((s) => ({ ...s, modifiedContent: 'external' })))
  expect(model.getValue()).toBe('external')
  view.update((prev) =>
    prev.map((s) => ({ ...s, contentGeneration: 1, modifiedContent: 'replacement' }))
  )
  expect(modifiedModel()).not.toBe(model)
  expect(modifiedModel().getValue()).toBe('replacement')
})

it('releases the edited instance on collapse and unmount and restores its draft on remount', async () => {
  const view = mountSections([section()])
  await vi.waitFor(() => expect(instances[0]?.contentListeners.size).toBe(1))
  const model = modifiedModel()
  act(() =>
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: 'draft' }], () => null)
  )
  view.update((prev) => prev.map((s) => ({ ...s, collapsed: true })))
  expect(instances[0].contentListeners.size).toBe(0)
  expect(view.modifiedEditorsRef.current.size).toBe(0)
  instances[0].getValue.mockClear()
  act(() => model.setValue('after collapse'))
  expect(instances[0].getValue).not.toHaveBeenCalled()
  expect(view.sections()[0].modifiedContent).toBe('draft')
  view.update((prev) => prev.map((s) => ({ ...s, collapsed: false, contentGeneration: 1 })))
  await vi.waitFor(() => expect(instances[1]?.contentListeners.size).toBe(1))
  expect(modifiedModel(1).getValue()).toBe('draft')
  view.unmount()
  expect(instances[1].contentListeners.size).toBe(0)
  expect(view.modifiedEditorsRef.current.size).toBe(0)
})

it('does not subscribe read-only sections to edit publication', async () => {
  const initial = { ...section(), area: 'staged' as const }
  const view = mountSections([initial])
  await vi.waitFor(() => expect(instances).toHaveLength(1))
  expect(instances[0].contentListeners.size).toBe(0)
  instances[0].getValue.mockClear()
  act(() => modifiedModel().setValue('not published'))
  expect(instances[0].getValue).not.toHaveBeenCalled()
  expect(view.sections()[0]).toBe(initial)
})

it('does not mistake a previous model publication for an echo from its replacement', async () => {
  const view = mountSections([section()])
  await vi.waitFor(() => expect(instances[0]?.contentListeners.size).toBe(1))
  const model = modifiedModel()
  act(() =>
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: 'typed' }], () => null)
  )
  const replacement = monaco.editor.createModel('foreign', 'plaintext')
  act(() => instances[0].diff.getModifiedEditor().setModel(replacement))
  view.update((prev) => prev.map((s) => ({ ...s })))
  expect(replacement.getValue()).toBe('typed')
  expect(view.sections()[0].modifiedContent).toBe('typed')
  expect(model.getValue()).toBe('typed')
  instances[0].getValue.mockClear()
  act(() =>
    replacement.pushEditOperations(
      [],
      [{ range: replacement.getFullModelRange(), text: 'successor' }],
      () => null
    )
  )
  expect(instances[0].getValue).toHaveBeenCalledOnce()
  expect(view.sections()[0].modifiedContent).toBe('successor')
})
