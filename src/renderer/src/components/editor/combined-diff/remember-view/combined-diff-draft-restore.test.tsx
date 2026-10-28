// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DiffSectionItemProps } from '../../diff-section-item-props'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { DiffSectionItem } from '../../DiffSectionItem'
import type { DiffSection } from '../../diff-section-types'
import type { OpenFile } from '@/store/slices/editor'
import { useCombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { useCombinedDiffSectionLoadRegistry } from '../load-sections/combined-diff-section-load-registry'
import { useCombinedDiffSectionLoader } from '../load-sections/use-combined-diff-section-loader'
import { useCombinedDiffViewRestore } from './use-combined-diff-view-restore'
import { useCombinedDiffViewPersist } from './use-combined-diff-view-persist'
import { clearCombinedDiffViewMemory, readCombinedDiffViewMemory } from './combined-diff-view-cache'
import { canAutoSaveOpenFile } from '../../editor-autosave'
import { needsSavePromptOnClose } from '@/store/slices/editor/buffers/editor-buffer-close-rule'

const probe = vi.hoisted(() => {
  const editors: { edit: (value: string) => void }[] = []
  const models = new Map<
    string,
    { uri: { toString: () => string }; isAttachedToEditor: () => boolean; dispose: () => void }
  >()
  const modelDisposals: string[] = []
  const openFiles: OpenFile[] = []
  return {
    editors,
    models,
    modelDisposals,
    diskReads: vi.fn(async () => ({
      kind: 'text',
      originalContent: 'committed baseline',
      modifiedContent: 'disk baseline',
      originalIsBinary: false,
      modifiedIsBinary: false
    })),
    state: {
      editorFontZoomLevel: 0,
      addDiffComment: vi.fn(),
      deleteDiffComment: vi.fn(),
      updateDiffComment: vi.fn(),
      scrollToDiffCommentId: null,
      setScrollToDiffCommentId: vi.fn(),
      diffCommentsByWorktree: {},
      editorDrafts: {},
      openFiles
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof probe.state) => unknown) => selector(probe.state),
    { getState: () => probe.state }
  )
}))
vi.mock('@/store/worktree-diff-comments-selector', () => ({ selectWorktreeDiffComments: () => [] }))
vi.mock('../../../diff-comments/useDiffCommentDecorator', () => ({
  useDiffCommentDecorator: () => {}
}))
vi.mock('../../diff-editor-line-number-options', () => ({
  applyDiffEditorLineNumberOptions: () => ({ dispose() {} })
}))
vi.mock('../../editor-shortcuts', () => ({
  installEditorSaveShortcut: () => () => {},
  installMonacoEditorFindShortcut: () => () => {}
}))
vi.mock('../../DiffSectionHeader', () => ({ DiffSectionHeader: () => null }))
vi.mock('../../useDiffSectionLayoutMetrics', () => ({
  useDiffSectionLayoutMetrics: () => ({
    lineStats: null,
    sectionBodyHeight: 200,
    useIntrinsicImageHeight: false,
    isLargeDiffLimited: false
  })
}))
vi.mock('../load-sections/fetch-combined-diff-section', () => ({
  fetchCombinedDiffSection: probe.diskReads
}))
vi.mock('@/lib/monaco-setup', () => ({
  monaco: {
    Uri: { parse: (value: string) => value },
    editor: {
      getModel: (uri: string) => probe.models.get(uri) ?? null,
      getModels: () => [...probe.models.values()]
    }
  }
}))
vi.mock('../../DiffSectionBody', () => ({
  DiffSectionBody: ({
    section,
    modelPathBase,
    onMount
  }: {
    section: DiffSection
    modelPathBase: string
    onMount: (editor: unknown) => void
  }) => {
    const mount = useRef(onMount)
    const content = useRef(section.modifiedContent)
    content.current = section.modifiedContent
    useEffect(() => {
      if (section.loading) {
        return
      }
      let value = content.current
      let attached = true
      const changes = new Set<() => void>()
      const disposal = new Set<() => void>()
      const node = document.createElement('div')
      const disposable = () => ({ dispose() {} })
      for (const suffix of ['original', 'modified']) {
        const path = `${modelPathBase}:${suffix}`
        probe.models.set(path, {
          uri: { toString: () => path },
          isAttachedToEditor: () => attached,
          dispose: () => {
            probe.modelDisposals.push(path)
            probe.models.delete(path)
          }
        })
      }
      const modified = {
        getValue: () => value,
        getModel: () => ({ getLineCount: () => 1 }),
        getContainerDomNode: () => node,
        getContentHeight: () => 200,
        onDidContentSizeChange: disposable,
        onDidDispose: (listener: () => void) => {
          disposal.add(listener)
          return { dispose: () => disposal.delete(listener) }
        },
        onDidChangeModelContent: (listener: () => void) => {
          changes.add(listener)
          return { dispose: () => changes.delete(listener) }
        }
      }
      probe.editors.push({
        edit: (next) => {
          value = next
          for (const listener of changes) {
            listener()
          }
        }
      })
      mount.current({
        getModifiedEditor: () => modified,
        getOriginalEditor: () => modified,
        getContainerDomNode: () => node,
        onDidUpdateDiff: disposable,
        getLineChanges: () => null
      })
      return () => {
        attached = false
        for (const listener of disposal) {
          listener()
        }
      }
    }, [modelPathBase, section.loading])
    return null
  }
}))

const empty: [] = []
const entries: GitStatusEntry[] = [
  { path: 'file.txt', status: 'modified', area: 'unstaged', added: 1 }
]
function fileAt(index: number): OpenFile {
  return {
    id: `wt-${index}::all-diffs::uncommitted`,
    mode: 'diff',
    diffSource: 'combined-uncommitted',
    filePath: `/repo-${index}`,
    worktreeId: `wt-${index}`,
    relativePath: '',
    language: 'plaintext',
    isDirty: false,
    uncommittedEntriesSnapshot: [
      { path: 'file.txt', status: 'modified', area: 'unstaged', added: 1 }
    ]
  }
}
function View({ file }: { file: OpenFile }) {
  const [sections, setSections] = useState<DiffSection[]>([])
  const [heights, setHeights] = useState<Record<number, number>>({})
  const [, setGeneration] = useState(0)
  const [sideBySide, setSideBySide] = useState(false)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const modifiedEditorsRef = useRef<DiffSectionItemProps['modifiedEditorsRef']['current']>(
    new Map()
  )
  const handleSectionSaveRef = useRef(async () => {})
  const registry = useCombinedDiffSectionLoadRegistry(sections)
  const entrySet = useCombinedDiffEntrySet({
    file,
    gitStatusEntries: entries,
    liveBranchEntries: empty,
    sectionsRef: registry.sectionsRef
  })
  const restore = useCombinedDiffViewRestore({
    entrySet,
    gitStatusEntries: entries,
    registry,
    setGeneration,
    setSectionHeights: setHeights,
    setSections,
    setSideBySide,
    viewStateKey: file.id,
    worktreeId: file.worktreeId
  })
  const loader = useCombinedDiffSectionLoader({
    entrySet,
    file,
    registry,
    sectionCount: sections.length,
    setSectionHeights: setHeights,
    setSections
  })
  useCombinedDiffViewPersist({
    combinedGitStatusSignature: '',
    entryCount: entrySet.entries.length,
    entrySignature: entrySet.entrySignature,
    memoryLeaseRef: restore.memoryLeaseRef,
    scrollContainerRef,
    sectionHeights: heights,
    sections,
    loadedIndicesRef: registry.loadedIndicesRef,
    sideBySide,
    viewStateKey: file.id
  })
  return (
    <>
      <output data-testid="state">
        {JSON.stringify(
          sections.map(({ modifiedContent, dirty, loading }) => ({
            modifiedContent,
            dirty,
            loading
          }))
        )}
      </output>
      {sections.map((section, index) => (
        <DiffSectionItem
          key={section.key}
          section={section}
          index={index}
          isBranchMode={false}
          sideBySide={false}
          isDark={false}
          settings={null}
          sectionHeight={heights[index]}
          worktreeId={file.worktreeId}
          loadSection={loader.loadSection}
          retrySection={() => {}}
          toggleSection={() => {}}
          openSection={() => {}}
          openSectionTitle="Open"
          setSectionHeights={setHeights}
          setSections={setSections}
          modifiedEditorsRef={modifiedEditorsRef}
          handleSectionSaveRef={handleSectionSaveRef}
        />
      ))}
    </>
  )
}

afterEach(() => {
  cleanup()
  clearCombinedDiffViewMemory()
  probe.editors.length = 0
  probe.models.clear()
})

it('restores an unsaved combined-diff edit after visiting twenty other views', async () => {
  probe.state.openFiles = Array.from({ length: 21 }, (_, index) => fileAt(index))
  const first = probe.state.openFiles[0]!
  const view = render(<View key={first.id} file={first} />)
  await waitFor(() => expect(view.getByTestId('state').textContent).toContain('disk baseline'))
  await waitFor(() => expect(probe.editors.at(-1)).toBeDefined())
  await act(async () => {
    probe.editors.at(-1)!.edit('unsaved combined draft')
  })
  expect(view.getByTestId('state').textContent).toContain('"dirty":true')
  expect(readCombinedDiffViewMemory(first.id)?.view?.sections[0]?.modifiedContent).toBe(
    'unsaved combined draft'
  )
  expect(canAutoSaveOpenFile(first)).toBe(false)
  expect(probe.state.editorDrafts).toEqual({})
  expect(
    needsSavePromptOnClose(
      { openFiles: probe.state.openFiles, editorBufferIdOf: {}, editorBufferViews: {} },
      first.id
    )
  ).toBe(false)
  const firstModelPath = 'diff-section:wt-0:unstaged%3Afile.txt:0:modified'
  expect(probe.models.has(firstModelPath)).toBe(true)
  for (let index = 1; index < 21; index++) {
    const file = probe.state.openFiles[index]!
    view.rerender(<View key={file.id} file={file} />)
    await waitFor(() => expect(view.getByTestId('state').textContent).toContain('disk baseline'))
  }
  await waitFor(() => expect(probe.models.has(firstModelPath)).toBe(false))
  expect(probe.modelDisposals).toContain(firstModelPath)
  expect(readCombinedDiffViewMemory(first.id)?.view?.sections[0]?.modifiedContent).toBe(
    'unsaved combined draft'
  )
  const readsBeforeRevisit = probe.diskReads.mock.calls.length
  view.rerender(<View key={first.id} file={first} />)
  await waitFor(() =>
    expect(view.getByTestId('state').textContent).toContain('unsaved combined draft')
  )
  expect(view.getByTestId('state').textContent).toContain('"dirty":true')
  expect(probe.diskReads.mock.calls.length).toBe(readsBeforeRevisit)
})
