// @vitest-environment happy-dom
import { act } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { MarkdownReviewNote } from '@/lib/markdown-review-notes'
import { useRichMarkdownReviewCopyFeedback } from './useRichMarkdownReviewCopyFeedback'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type Options = Parameters<typeof useRichMarkdownReviewCopyFeedback>[0]
type Feedback = ReturnType<typeof useRichMarkdownReviewCopyFeedback>
type MountedReview = {
  root: Root
  container: HTMLDivElement
  options: Options
  control: { current: Feedback | null }
}

function CopyReview({ view }: { view: MountedReview }) {
  view.control.current = useRichMarkdownReviewCopyFeedback(view.options)
  return <div ref={view.options.rootRef} />
}

async function renderReview(view: MountedReview): Promise<void> {
  await act(async () => view.root.render(<CopyReview view={view} />))
}

function initialNote(): MarkdownReviewNote {
  return {
    id: 'first-note',
    createdAt: 1,
    worktreeId: 'folder-owner',
    filePath: 'notes.md',
    source: 'markdown',
    lineNumber: 1,
    selectedText: 'abc',
    body: `Review abc ${'x'.repeat(100_000)}`,
    side: 'modified'
  }
}

async function replaceReviewInputs(replaceContent: boolean) {
  const container = document.body.appendChild(document.createElement('div'))
  const note = initialNote()
  const notes = [note]
  const view: MountedReview = {
    root: createRoot(container),
    container,
    options: {
      markdownReviewContent: `abc\n\n${'x'.repeat(100_000)}`,
      markdownReviewNotes: notes,
      rootRef: { current: null }
    },
    control: { current: null }
  }
  await renderReview(view)
  const retired = { notes: new WeakRef(notes), note: new WeakRef(note) }
  for (const content of ['tiny-a', 'tiny-b', 'tiny-c']) {
    view.options = {
      ...view.options,
      markdownReviewContent: replaceContent ? content : view.options.markdownReviewContent,
      markdownReviewNotes: []
    }
    await renderReview(view)
  }
  return { view, retired }
}

async function closeReview(view: MountedReview): Promise<void> {
  view.control.current?.clearReviewCopyTimers()
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
  it(`releases replaced review notes while ${replaceContent ? 'source changes' : 'source stays open'}`, async () => {
    const tasks: Awaited<ReturnType<typeof replaceReviewInputs>>[] = []
    try {
      for (let owner = 0; owner < 4; owner++) {
        tasks.push(await replaceReviewInputs(replaceContent))
      }
      await collect()
      expect(tasks.filter((task) => task.retired.notes.deref()).length).toBe(0)
      expect(tasks.filter((task) => task.retired.note.deref()).length).toBe(0)
    } finally {
      for (const task of tasks) {
        await closeReview(task.view)
      }
    }
  })
}
