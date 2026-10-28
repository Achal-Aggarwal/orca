// @vitest-environment happy-dom
import { act } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { RichMarkdownAnnotationOverlay } from './RichMarkdownAnnotationOverlay'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { registerRichMarkdownBlockSource } from './rich-markdown-block-source'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { useRichMarkdownReviewController } from './useRichMarkdownReviewController'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type Review = ReturnType<typeof useRichMarkdownReviewController>
type Options = Parameters<typeof useRichMarkdownReviewController>[0]
type SaveInput = Parameters<Options['addDiffComment']>[0]
type Control = { current: Review | null }
type ClosedReview = {
  editor: WeakRef<Editor>
  document: WeakRef<ProseMirrorNode>
  root: WeakRef<HTMLDivElement>
  submit: WeakRef<Review['submitAnnotation']>
  composer: WeakRef<Element> | null
  completion: Promise<void> | undefined
}

const target = {
  from: 1,
  to: 4,
  lineNumber: 1,
  selectedText: 'abc',
  top: 0,
  buttonTop: 0,
  buttonLeft: 0
}
const nextJob = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function pendingSave() {
  const gate = Promise.withResolvers<DiffComment | null>()
  const inputs: SaveInput[] = []
  const addDiffComment: Options['addDiffComment'] = (input) => {
    inputs.push(input)
    return gate.promise
  }
  return { ...gate, inputs, addDiffComment }
}

function createEditor(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  registerRichMarkdownBlockSource(editor, codec, false)
  return editor
}

function optionsFor(
  editor: Editor,
  source: string,
  addDiffComment: Options['addDiffComment']
): Options {
  return {
    addDiffComment,
    allDiffComments: [],
    content: source,
    editorRef: { current: editor },
    filePath: '/workspace/notes.md',
    markdownAnnotationsEnabled: true,
    markdownReviewContent: source,
    markdownSourceLineOffset: 0,
    rootRef: { current: null },
    scrollContainerRef: { current: null },
    worktreeId: 'folder-owner',
    worktreeRoot: '/workspace'
  }
}

function RetentionReview({ options, control }: { options: Options; control: Control }) {
  const review = useRichMarkdownReviewController(options)
  control.current = review
  return (
    <div ref={options.rootRef}>
      <RichMarkdownAnnotationOverlay
        target={null}
        popover={review.annotationPopover}
        markdownSourceLineOffset={0}
        onOpenPopover={review.openAnnotationPopover}
        onCancelPopover={() => review.setAnnotationPopover(null)}
        onSubmit={review.submitAnnotation}
      />
    </div>
  )
}

async function openReview(options: Options) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const control: Control = { current: null }
  await act(async () => root.render(<RetentionReview options={options} control={control} />))
  const review = control.current
  if (!review) {
    throw new Error('Review controller did not mount')
  }
  await act(async () => review.setAnnotationPopover({ ...target }))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  return { container, root, control }
}

async function closePendingReview(
  composer: boolean,
  addDiffComment: Options['addDiffComment']
): Promise<ClosedReview> {
  const source = `abc xyz\n\n${Array.from(
    { length: 100 },
    (_, index) => `_Block ${index} ${'x'.repeat(1024)}_`
  ).join('\n\n')}\n`
  const editor = createEditor(source)
  const options = optionsFor(editor, source, addDiffComment)
  const view = await openReview(options)
  const review = view.control.current
  const owner = options.rootRef.current
  if (!review || !owner) {
    throw new Error('Review owner did not mount')
  }
  const dialog = view.container.querySelector('[role="dialog"]')
  const refs: ClosedReview = {
    editor: new WeakRef(editor),
    document: new WeakRef(editor.state.doc),
    root: new WeakRef(owner),
    submit: new WeakRef(review.submitAnnotation),
    composer: dialog ? new WeakRef(dialog) : null,
    completion: undefined
  }
  if (composer) {
    const textarea = view.container.querySelector('textarea')
    const button = [...view.container.querySelectorAll('button')].find((element) =>
      element.textContent?.includes('Add note')
    )
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (!textarea || !button || !setValue) {
      throw new Error('Composer did not mount')
    }
    await act(async () => {
      setValue.call(textarea, 'Review abc')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button.click())
  } else {
    refs.completion = review.submitAnnotation('Review abc')
  }
  await nextJob()
  await act(async () => view.root.unmount())
  editor.destroy()
  options.editorRef.current = null
  options.rootRef.current = null
  view.control.current = null
  view.container.remove()
  await nextJob()
  return refs
}

async function openSuccessorComposer() {
  const editor = createEditor('tiny')
  const options = optionsFor(editor, 'tiny', () => Promise.resolve(null))
  const view = await openReview(options)
  return async () => {
    await act(async () => view.root.unmount())
    editor.destroy()
    options.editorRef.current = null
    options.rootRef.current = null
    view.control.current = null
    view.container.remove()
  }
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 4; round++) {
    await nextJob()
    globalThis.gc()
  }
}

for (const composer of [false, true]) {
  for (const outcome of ['success', 'failure']) {
    it(`releases closed ${composer ? 'composers' : 'review owners'} before ${outcome} settles`, async () => {
      const saves = Array.from({ length: 4 }, pendingSave)
      const closed: ClosedReview[] = []
      for (const save of saves) {
        closed.push(await closePendingReview(composer, save.addDiffComment))
      }
      // Move the editor factory and browser selection bookkeeping to the next live composer.
      const closeSuccessor = await openSuccessorComposer()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        for (const save of saves) {
          expect(save.inputs).toEqual([
            {
              worktreeId: 'folder-owner',
              filePath: 'notes.md',
              source: 'markdown',
              startLine: undefined,
              lineNumber: 1,
              selectedText: 'abc',
              body: 'Review abc',
              side: 'modified'
            }
          ])
        }
        await collect()
        expect(closed.filter((owner) => owner.editor.deref()).length).toBe(0)
        expect(closed.filter((owner) => owner.document.deref()).length).toBe(0)
        expect(closed.filter((owner) => owner.root.deref()).length).toBe(0)
        expect(closed.filter((owner) => owner.submit.deref()).length).toBe(0)
        expect(closed.filter((owner) => owner.composer?.deref()).length).toBe(0)
      } finally {
        await act(async () => {
          for (const [index, save] of saves.entries()) {
            const input = save.inputs[0]
            if (!input) {
              throw new Error('Accepted note was lost')
            }
            save.resolve(
              outcome === 'success' ? { ...input, id: `note-${index}`, createdAt: 1 } : null
            )
          }
          await Promise.all(closed.map((owner) => owner.completion))
          await nextJob()
        })
        errors.mockRestore()
        await closeSuccessor()
      }
    })
  }
}
