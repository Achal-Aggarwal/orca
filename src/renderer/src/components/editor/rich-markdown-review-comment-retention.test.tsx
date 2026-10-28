// @vitest-environment happy-dom
import { act } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { useRichMarkdownReviewController } from './useRichMarkdownReviewController'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type Options = Parameters<typeof useRichMarkdownReviewController>[0]
type Review = ReturnType<typeof useRichMarkdownReviewController>
type MountedReview = {
  root: Root
  container: HTMLDivElement
  options: Options
  control: { current: Review | null }
}

function ReviewOwner({ view }: { view: MountedReview }) {
  view.control.current = useRichMarkdownReviewController(view.options)
  return <div ref={view.options.rootRef} />
}

async function renderReview(view: MountedReview): Promise<void> {
  await act(async () => view.root.render(<ReviewOwner view={view} />))
}

async function removeInitialComment(replaceContent: boolean) {
  const comment: DiffComment = {
    id: 'retired-note',
    createdAt: 1,
    worktreeId: 'folder-owner',
    filePath: 'notes.md',
    source: 'markdown',
    lineNumber: 1,
    selectedText: 'abc',
    body: `Review abc ${'x'.repeat(100_000)}`,
    side: 'modified'
  }
  const container = document.body.appendChild(document.createElement('div'))
  const view: MountedReview = {
    root: createRoot(container),
    container,
    options: {
      addDiffComment: () => Promise.resolve(null),
      allDiffComments: [comment],
      content: 'abc',
      editorRef: { current: null },
      filePath: '/workspace/notes.md',
      markdownAnnotationsEnabled: true,
      markdownReviewContent: 'abc',
      markdownSourceLineOffset: 0,
      rootRef: { current: null },
      scrollContainerRef: { current: null },
      worktreeId: 'folder-owner',
      worktreeRoot: '/workspace'
    },
    control: { current: null }
  }
  await renderReview(view)
  const retired = new WeakRef(comment)
  for (const content of ['tiny-a', 'tiny-b', 'tiny-c']) {
    view.options = {
      ...view.options,
      allDiffComments: [],
      content: replaceContent ? content : view.options.content,
      markdownReviewContent: replaceContent ? content : view.options.markdownReviewContent
    }
    await renderReview(view)
  }
  return { view, retired }
}

async function closeReview(view: MountedReview): Promise<void> {
  view.control.current?.clearTransientReviewState()
  await act(async () => view.root.unmount())
  view.options.rootRef.current = null
  view.control.current = null
  view.container.remove()
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
  it(`releases removed comments while ${replaceContent ? 'source changes' : 'source stays open'}`, async () => {
    const tasks: Awaited<ReturnType<typeof removeInitialComment>>[] = []
    try {
      for (let owner = 0; owner < 4; owner++) {
        tasks.push(await removeInitialComment(replaceContent))
      }
      await collect()
      expect(tasks.filter((task) => task.retired.deref()).length).toBe(0)
    } finally {
      for (const task of tasks) {
        await closeReview(task.view)
      }
    }
  })
}
