// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { FileContent } from './editor-panel-content-types'
import type { OpenFile } from '@/store/slices/editor'

const probe = vi.hoisted(() => ({ scan: vi.fn(), render: vi.fn() }))
const contentState = vi.hoisted((): { fileContents: Record<string, FileContent> } => ({
  fileContents: {}
}))

vi.mock('./markdown-frontmatter', async (importActual) => {
  const actual = await importActual<typeof import('./markdown-frontmatter')>()
  return {
    ...actual,
    extractFrontMatter: (content: string) => {
      probe.scan(content.length)
      return actual.extractFrontMatter(content)
    }
  }
})
vi.mock('./useEditorPanelContentState', () => ({
  useEditorPanelContentState: () => ({
    fileContents: contentState.fileContents,
    diffContents: {},
    reloadContent: () => {}
  })
}))
vi.mock('./EditorPanelShell', () => ({
  EditorPanelShell: ({
    canShowMarkdownFrontmatterToggle
  }: {
    canShowMarkdownFrontmatterToggle: boolean
  }) => {
    probe.render()
    return <output>{String(canShowMarkdownFrontmatterToggle)}</output>
  }
}))

import EditorPanel from './EditorPanel'

const initialState = useAppStore.getInitialState()
const file: OpenFile = {
  id: '/repo/notes.md',
  filePath: '/repo/notes.md',
  relativePath: 'notes.md',
  worktreeId: 'wt-frontmatter',
  language: 'markdown',
  mode: 'edit',
  isDirty: false
}
let container: HTMLDivElement
let root: Root

describe('EditorPanel frontmatter availability', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    probe.scan.mockClear()
    probe.render.mockClear()
    useAppStore.setState(initialState, true)
    useAppStore.setState({
      openFiles: [file],
      activeFileId: file.id,
      markdownViewMode: { [file.id]: 'rich' },
      gitStatusByWorktree: { [file.worktreeId]: [] }
    })
    contentState.fileContents = {
      [file.id]: { content: '---\n' + 'x'.repeat(2 * 1024 * 1024), isBinary: false }
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialState, true)
  })

  it('does not rescan an unchanged fallback document on git refreshes', async () => {
    await act(async () => root.render(<EditorPanel />))
    expect(container.textContent).toBe('false')
    expect(probe.scan).toHaveBeenCalled()
    probe.scan.mockClear()
    const renders = probe.render.mock.calls.length

    for (let tick = 0; tick < 20; tick++) {
      await act(async () => {
        useAppStore.setState({ gitStatusByWorktree: { [file.worktreeId]: [] } })
      })
    }

    expect(probe.render.mock.calls.length).toBeGreaterThan(renders)
    expect(probe.scan).not.toHaveBeenCalled()
    expect(container.textContent).toBe('false')
  })

  it('updates availability for draft edits and source/rich mode changes', async () => {
    await act(async () => root.render(<EditorPanel />))
    await act(async () => {
      useAppStore.getState().setEditorDraft(file.id, '---\ntitle: Notes\n---\n# Notes\n')
    })
    expect(container.textContent).toBe('true')

    await act(async () => useAppStore.getState().setMarkdownViewMode(file.id, 'source'))
    expect(container.textContent).toBe('false')
    await act(async () => useAppStore.getState().setMarkdownViewMode(file.id, 'rich'))
    expect(container.textContent).toBe('true')

    await act(async () => useAppStore.getState().setEditorDraft(file.id, '# Notes\n'))
    expect(container.textContent).toBe('false')
  })

  it('keeps hook order and current content when the final tab closes and another opens', async () => {
    await act(async () => root.render(<EditorPanel />))
    await act(async () => useAppStore.setState({ activeFileId: null, openFiles: [] }))
    expect(container.textContent).toBe('')
    contentState.fileContents = {
      [file.id]: { content: '+++\ntitle = "Notes"\n+++\n# Notes\n', isBinary: false }
    }
    await act(async () => useAppStore.setState({ activeFileId: file.id, openFiles: [file] }))
    expect(container.textContent).toBe('true')
  })

  it('uses the preview source draft and falls back to loaded preview content', async () => {
    const preview = {
      ...file,
      id: 'preview-notes',
      mode: 'markdown-preview' as const,
      markdownPreviewSourceFileId: file.id
    }
    contentState.fileContents = {
      [preview.id]: { content: '---\ntitle: Disk\n---\n# Notes\n', isBinary: false }
    }
    useAppStore.setState({
      activeFileId: preview.id,
      openFiles: [preview],
      editorDrafts: { [file.id]: '# Draft without frontmatter\n' }
    })
    await act(async () => root.render(<EditorPanel />))
    expect(container.textContent).toBe('false')

    await act(async () => useAppStore.setState({ editorDrafts: {} }))
    expect(container.textContent).toBe('true')
  })
})
