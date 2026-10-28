// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import MarkdownPreview from './MarkdownPreview'

const state = vi.hoisted(() => {
  const noop = () => {}
  const asyncNoop = async () => null
  const worktreesByRepo: Record<
    string,
    { id: string; repoId: string; path: string; hostId: string; diffComments: DiffComment[] }[]
  > = {}
  const repos: { id: string; path: string; hostId: string }[] = []
  return {
    openFile: noop,
    activateMarkdownLink: noop,
    openMarkdownPreview: noop,
    setMarkdownViewMode: noop,
    markdownFrontmatterVisible: {},
    setPendingEditorReveal: noop,
    addDiffComment: asyncNoop,
    deleteDiffComment: asyncNoop,
    updateDiffComment: asyncNoop,
    clearDeliveredDiffComments: asyncNoop,
    keybindings: {},
    worktreesByRepo,
    repos,
    folderWorkspaces: [],
    projectGroups: [],
    openFiles: [],
    activeFileIdByWorktree: {},
    settings: { openLinksInApp: true, theme: 'light' },
    editorFontZoomLevel: 0,
    runtimeEnvironments: []
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (snapshot: typeof state) => unknown) => selector(state), {
    getState: () => state,
    subscribe: () => () => {}
  })
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en', resolvedLanguage: 'en', on() {}, off() {} },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))

type PreviewView = {
  root: Root
  container: HTMLDivElement
  options: {
    content: string
    filePath: string
    sourceWorktreeId: string
    sourceRuntimeEnvironmentId: null
    scrollCacheKey: string
    markdownAnnotationsEnabled: boolean
  }
}

function PreviewOwner({ view }: { view: PreviewView }) {
  return <MarkdownPreview {...view.options} />
}

async function renderPreview(view: PreviewView): Promise<void> {
  await act(async () => view.root.render(<PreviewOwner view={view} />))
}

async function removeInitialPreviewNote(owner: number, replaceContent: boolean) {
  const note: DiffComment = {
    id: `note-${owner}`,
    source: 'markdown',
    worktreeId: `owner-${owner}`,
    filePath: 'notes.md',
    lineNumber: 1,
    selectedText: 'abc',
    body: `Review abc ${'x'.repeat(100_000)}`,
    side: 'modified',
    createdAt: owner
  }
  const repoId = `repo-${owner}`
  const workspace = {
    id: `owner-${owner}`,
    repoId,
    path: `/folder-${owner}`,
    hostId: 'local',
    diffComments: [note]
  }
  state.worktreesByRepo = { ...state.worktreesByRepo, [repoId]: [workspace] }
  state.repos = [...state.repos, { id: repoId, path: workspace.path, hostId: 'local' }]
  const container = document.body.appendChild(document.createElement('div'))
  const view: PreviewView = {
    root: createRoot(container),
    container,
    options: {
      content: `abc\n\n${'y'.repeat(100_000)}`,
      filePath: `${workspace.path}/notes.md`,
      sourceWorktreeId: workspace.id,
      sourceRuntimeEnvironmentId: null,
      scrollCacheKey: `preview-${owner}`,
      markdownAnnotationsEnabled: true
    }
  }
  await renderPreview(view)
  const retired = new WeakRef(note)
  for (const content of ['tiny-a', 'tiny-b', 'tiny-c']) {
    state.worktreesByRepo = {
      ...state.worktreesByRepo,
      [repoId]: [{ ...workspace, diffComments: [] }]
    }
    view.options = {
      ...view.options,
      content: replaceContent ? content : view.options.content
    }
    await renderPreview(view)
  }
  return { view, retired }
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 4; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

for (const replaceContent of [false, true]) {
  it(`releases removed preview notes while ${replaceContent ? 'source changes' : 'source stays open'}`, async () => {
    const tasks: Awaited<ReturnType<typeof removeInitialPreviewNote>>[] = []
    try {
      for (let owner = 0; owner < 4; owner++) {
        tasks.push(await removeInitialPreviewNote(owner, replaceContent))
      }
      for (let update = 0; update < 3; update++) {
        for (const { view } of tasks) {
          await renderPreview(view)
        }
      }
      await collect()
      expect(
        tasks.every((task) => task.view.container.textContent?.includes('Review notes0'))
      ).toBe(true)
      expect(tasks.filter((task) => task.retired.deref()).length).toBe(0)
    } finally {
      for (const { view } of tasks) {
        await act(async () => view.root.unmount())
        view.container.remove()
      }
      state.worktreesByRepo = {}
      state.repos = []
    }
  })
}
