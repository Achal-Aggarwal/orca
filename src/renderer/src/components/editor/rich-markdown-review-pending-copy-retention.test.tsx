// @vitest-environment happy-dom
import { act } from 'react'
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
type CopyView = {
  root: Root
  container: HTMLDivElement
  options: Options
  control: { current: Feedback | null }
}

function CopyOwner({ view }: { view: CopyView }) {
  view.control.current = useRichMarkdownReviewCopyFeedback(view.options)
  return <div ref={view.options.rootRef} />
}

async function renderCopy(view: CopyView): Promise<void> {
  await act(async () => view.root.render(<CopyOwner view={view} />))
}

async function stageCopies(single: boolean) {
  const container = document.body.appendChild(document.createElement('div'))
  const view: CopyView = {
    root: createRoot(container),
    container,
    options: {
      markdownReviewContent: 'initial',
      markdownReviewNotes: [],
      rootRef: { current: null }
    },
    control: { current: null }
  }
  const notes: WeakRef<MarkdownReviewNote>[] = []
  const operations: Promise<void>[] = []
  await renderCopy(view)
  for (let copy = 0; copy < 4; copy++) {
    const note: MarkdownReviewNote = {
      id: `note-${copy}`,
      worktreeId: 'folder-owner',
      filePath: 'notes.md',
      source: 'markdown',
      lineNumber: 1,
      selectedText: 'abc',
      body: 'tiny',
      createdAt: copy,
      side: 'modified'
    }
    view.options = {
      ...view.options,
      markdownReviewContent: `abc\n${'x'.repeat(100_000)}`,
      markdownReviewNotes: [note]
    }
    await renderCopy(view)
    const feedback = view.control.current
    if (!feedback) {
      throw new Error('Copy feedback did not mount')
    }
    notes.push(new WeakRef(note))
    operations.push(
      single
        ? feedback.handleCopyMarkdownReviewNote(note)
        : feedback.handleCopyMarkdownReviewNotes()
    )
    for (let update = 0; update < 3; update++) {
      view.options = {
        ...view.options,
        markdownReviewContent: `tiny-${update}`,
        markdownReviewNotes: []
      }
      await renderCopy(view)
    }
  }
  return { view, notes, operations }
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 4; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

for (const single of [false, true]) {
  it(`releases retired ${single ? 'individual' : 'all-note'} inputs before clipboard writes settle`, async () => {
    const clipboard = Promise.withResolvers<void>()
    const writes: string[] = []
    const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          writeClipboardText: (text: string) => {
            writes.push(text)
            return clipboard.promise
          }
        }
      }
    })
    const task = await stageCopies(single)
    let completed = 0
    const completions = task.operations.map((operation) => operation.then(() => completed++))
    try {
      await collect()
      expect(writes.length).toBe(4)
      expect(writes.every((text) => text.length < 100)).toBe(true)
      expect(completed).toBe(0)
      expect(task.notes.filter((note) => note.deref()).length).toBe(0)
    } finally {
      clipboard.resolve()
      await act(async () => {
        await Promise.all(completions)
      })
      task.view.control.current?.clearReviewCopyTimers()
      await act(async () => task.view.root.unmount())
      task.view.options.rootRef.current = null
      task.view.control.current = null
      task.view.container.remove()
      if (previousApi) {
        Object.defineProperty(window, 'api', previousApi)
      } else {
        Reflect.deleteProperty(window, 'api')
      }
    }
  })
}
