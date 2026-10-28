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
      deliveringContent = true
      try {
        for (const listener of contentListeners) {
          listener()
        }
      } finally {
        deliveringContent = false
      }
    })
  }
  let deliveringContent = false
  const publicationReads: number[] = []
  const getValue = vi.fn(() => {
    if (deliveringContent) {
      publicationReads.push(pair?.modified.getValueLength() ?? 0)
    }
    return pair?.modified.getValue() ?? ''
  })
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
  return { diff, getValue, contentListeners, publicationReads }
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

it.each([1, 10])(
  'shares publication reads across %i combined-diff panes without dropping drafts',
  async (panes) => {
    const initial = 'shared row\n'.repeat(10000)
    const views = Array.from({ length: panes }, () => mountSections([section('shared', initial)]))
    await vi.waitFor(() => expect(instances).toHaveLength(panes))
    await vi.waitFor(() => expect(instances.every((i) => i.contentListeners.size === 1)).toBe(true))
    const model = modifiedModel()
    expect(instances.every((instance) => instance.diff.getModel()?.modified === model)).toBe(true)
    for (const instance of instances) {
      instance.getValue.mockClear()
      instance.publicationReads.length = 0
    }
    for (const action of ['edit', 'undo', 'redo']) {
      act(() => {
        if (action === 'edit') {
          model.pushEditOperations(
            [],
            [{ range: new monaco.Range(1, 1, 1, 1), text: 'typed ' }],
            () => null
          )
        } else if (action === 'undo') {
          model.undo()
        } else {
          model.redo()
        }
      })
      const expected = action === 'undo' ? initial : `typed ${initial}`
      for (const view of views) {
        expect(view.sections()[0].modifiedContent).toBe(expected)
        expect(view.sections()[0].dirty).toBe(action !== 'undo')
      }
      expect(instances.reduce((sum, instance) => sum + instance.publicationReads.length, 0)).toBe(1)
      for (const instance of instances) {
        instance.publicationReads.length = 0
      }
    }
    for (const view of views) {
      view.unmount()
    }
    expect(instances.every((instance) => instance.contentListeners.size === 0)).toBe(true)
    for (const instance of instances) {
      instance.getValue.mockClear()
    }
    model.setValue('after close')
    expect(instances.every((instance) => instance.getValue.mock.calls.length === 0)).toBe(true)
  }
)
