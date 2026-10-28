// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { getRichMarkdownCommentBlocks } from './rich-markdown-comment-blocks'
import { getRichMarkdownAnnotationHighlightRangesForComment } from './rich-markdown-review-annotations'
import { measureRichMarkdownReviewNotePositions } from './rich-markdown-review-note-positioning'

const editors: Editor[] = []

function createEditor(count: number) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: Array.from({ length: count }, (_, index) => `paragraph ${index}`).join('\n\n'),
    contentType: 'markdown'
  })
  editors.push(editor)
  getRichMarkdownCommentBlocks(editor)
  return editor
}

function comment(index: number): DiffComment {
  return {
    id: `note-${index}`,
    worktreeId: 'workspace',
    filePath: 'notes.md',
    source: 'markdown',
    lineNumber: 2 * index + 1,
    selectedText: `paragraph ${index}`,
    body: 'Review',
    createdAt: index,
    side: 'modified'
  }
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  vi.restoreAllMocks()
})

describe('review anchor reuse during geometry refreshes', () => {
  it.each([10, 100])(
    'reuses selected-text ranges for %i review notes while remeasuring coordinates',
    (count) => {
      const editor = createEditor(10 * count)
      const container = document.createElement('div')
      let viewportTop = 0
      vi.spyOn(container, 'getBoundingClientRect').mockImplementation(
        () => new DOMRect(0, viewportTop, 600, 400)
      )
      const coords = vi
        .spyOn(editor.view, 'coordsAtPos')
        .mockImplementation((pos) => ({ top: pos, bottom: pos + 20, left: 0, right: 1 }))
      const markdownComments = Array.from({ length: count }, (_, index) => comment(index))
      const args = { editor, container, markdownComments, markdownSourceLineOffset: 0 }
      const visits = vi.spyOn(editor.state.doc, 'nodesBetween')
      const before = measureRichMarkdownReviewNotePositions(args)
      expect(visits).toHaveBeenCalledTimes(count)
      visits.mockClear()
      coords.mockClear()
      viewportTop = -10
      const after = measureRichMarkdownReviewNotePositions(args)
      expect(after.map((entry) => entry.top)).toEqual(before.map((entry) => entry.top + 10))
      expect(coords).toHaveBeenCalledTimes(count)
      expect(visits).not.toHaveBeenCalled()
    }
  )

  it('invalidates reused ranges after document edits and in-place comment changes', () => {
    const editor = createEditor(3)
    const note = comment(1)
    const initial = getRichMarkdownAnnotationHighlightRangesForComment(editor, note, 0)
    editor.view.dispatch(editor.state.tr.insertText('prefix ', 1))
    const moved = getRichMarkdownAnnotationHighlightRangesForComment(editor, note, 0)
    expect(moved).toEqual(initial.map((range) => ({ from: range.from + 7, to: range.to + 7 })))
    note.selectedText = 'paragraph 2'
    note.lineNumber = 5
    const last = getRichMarkdownAnnotationHighlightRangesForComment(editor, note, 0)
    expect(last[0]?.from).toBeGreaterThan(moved[0]!.from)
    note.selectedText = 'missing selection'
    expect(getRichMarkdownAnnotationHighlightRangesForComment(editor, note, 0)).toEqual([])
    note.selectedText = ''
    expect(getRichMarkdownAnnotationHighlightRangesForComment(editor, note, 0)).toEqual([])
  })

  it('rechecks source offsets and changed block snapshots before reusing a range', () => {
    const editor = createEditor(3)
    const note = comment(1)
    const blocks = getRichMarkdownCommentBlocks(editor)
    const first = getRichMarkdownAnnotationHighlightRangesForComment(editor, note, 0, blocks)
    const visits = vi.spyOn(editor.state.doc, 'nodesBetween')
    expect(getRichMarkdownAnnotationHighlightRangesForComment(editor, note, 0, blocks)).toBe(first)
    expect(visits).not.toHaveBeenCalled()
    expect(getRichMarkdownAnnotationHighlightRangesForComment(editor, note, 2, blocks)).toEqual(
      first
    )
    expect(visits).toHaveBeenCalledTimes(2)
    visits.mockClear()
    expect(
      getRichMarkdownAnnotationHighlightRangesForComment(editor, note, 2, [...blocks])
    ).toEqual(first)
    expect(visits).toHaveBeenCalledTimes(2)
  })
})
