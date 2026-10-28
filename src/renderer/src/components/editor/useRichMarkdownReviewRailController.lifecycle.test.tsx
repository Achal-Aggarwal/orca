// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRichMarkdownAnnotationHighlightExtension,
  richMarkdownAnnotationHighlightPluginKey
} from './rich-markdown-annotation-highlight'
import { useRichMarkdownReviewRailController } from './useRichMarkdownReviewRailController'
import type { DiffComment } from '../../../../shared/diff-comment-types'

const frames = new Map<number, FrameRequestCallback>()
const editors: Editor[] = []
let nextFrame = 0

const comment: DiffComment = {
  id: 'note',
  worktreeId: 'workspace',
  filePath: 'note.md',
  source: 'markdown',
  lineNumber: 1,
  selectedText: 'selected',
  body: 'Review note',
  createdAt: 0,
  side: 'modified'
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
})

afterEach(() => {
  cleanup()
  for (const editor of editors.splice(0)) {
    if (!editor.isDestroyed) {
      editor.destroy()
    }
  }
  frames.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function makeEditor(): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [StarterKit, createRichMarkdownAnnotationHighlightExtension()],
    content: '<p>selected body</p>'
  })
  editors.push(editor)
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 0, right: 1, top: 0, bottom: 1 })
  vi.runOnlyPendingTimers()
  return editor
}

function mountRail(editor: Editor) {
  const editorRef = { current: editor }
  const container = document.createElement('div')
  const card = document.createElement('div')
  card.dataset.richMarkdownReviewNoteId = comment.id
  container.appendChild(card)
  const scroll = vi.spyOn(container, 'scrollTo').mockImplementation(() => {})
  const scrollContainerRef = { current: container }
  const { result, unmount } = renderHook(() =>
    useRichMarkdownReviewRailController({
      canAnnotateRichMarkdown: true,
      content: 'selected body',
      editorRef,
      markdownComments: [],
      markdownSourceLineOffset: 0,
      markdownSourceLineOffsetRef: { current: 0 },
      scrollContainerRef
    })
  )
  return { result, unmount, editorRef, scroll }
}

function flushFrame(): void {
  const pending = Array.from(frames.values())
  frames.clear()
  act(() => {
    for (const callback of pending) {
      callback(performance.now())
    }
  })
}

describe('rich review rail animation ownership', () => {
  it.each(['root detach', 'unmount'])(
    'cancels queued source pulses before %s can start an orphan timer',
    (boundary) => {
      const editor = makeEditor()
      const rail = mountRail(editor)
      act(() => rail.result.current.scrollRichMarkdownReviewNoteSourceIntoView(comment))
      expect(frames.size).toBe(1)
      act(() => {
        if (boundary === 'unmount') {
          rail.unmount()
        } else {
          rail.result.current.clearAttentionTimers()
        }
      })
      flushFrame()
      expect(frames.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(
        richMarkdownAnnotationHighlightPluginKey.getState(editor.state)?.activeRange
      ).toBeNull()
    }
  )

  it.each(['replacement', 'destruction', 'edit'])(
    'drops a source pulse after editor %s before the frame',
    (boundary) => {
      const editor = makeEditor()
      const rail = mountRail(editor)
      const next = boundary === 'replacement' ? makeEditor() : editor
      act(() => rail.result.current.scrollRichMarkdownReviewNoteSourceIntoView(comment))
      act(() => {
        if (boundary === 'replacement') {
          rail.editorRef.current = next
        } else if (boundary === 'destruction') {
          editor.destroy()
        } else {
          editor.commands.insertContent('changed')
        }
      })
      const timerCountBeforeFrame = vi.getTimerCount()
      flushFrame()
      expect(vi.getTimerCount()).toBe(timerCountBeforeFrame)
      expect(richMarkdownAnnotationHighlightPluginKey.getState(next.state)?.activeRange).toBeNull()
    }
  )

  it('does not clear a successor editor highlight when the previous pulse timeout settles', () => {
    const editor = makeEditor()
    const next = makeEditor()
    const rail = mountRail(editor)
    act(() => rail.result.current.scrollRichMarkdownReviewNoteSourceIntoView(comment))
    flushFrame()
    expect(richMarkdownAnnotationHighlightPluginKey.getState(editor.state)?.activeRange).toEqual({
      from: 1,
      to: 9
    })
    act(() => {
      rail.editorRef.current = next
      next.view.dispatch(
        next.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, {
          activeRange: { from: 10, to: 14 }
        })
      )
      vi.advanceTimersByTime(900)
    })
    expect(richMarkdownAnnotationHighlightPluginKey.getState(next.state)?.activeRange).toEqual({
      from: 10,
      to: 14
    })
  })

  it.each([false, true])(
    'cancels note pulse and card centering with first frame flushed: %s',
    (flush) => {
      const rail = mountRail(makeEditor())
      act(() => rail.result.current.scrollRichMarkdownReviewNoteCardIntoView(comment.id))
      expect(frames.size).toBe(2)
      if (flush) {
        flushFrame()
        expect(vi.getTimerCount()).toBe(1)
      }
      act(() => rail.result.current.clearAttentionTimers())
      flushFrame()
      flushFrame()
      expect(vi.getTimerCount()).toBe(0)
      expect(frames.size).toBe(0)
      expect(rail.scroll).not.toHaveBeenCalled()
    }
  )

  it('keeps one pending note pulse for rapid repeated requests and clears it after 900ms', () => {
    const rail = mountRail(makeEditor())
    act(() => {
      rail.result.current.scrollRichMarkdownReviewNoteCardIntoView('first')
      rail.result.current.scrollRichMarkdownReviewNoteCardIntoView('last')
    })
    expect(frames.size).toBe(2)
    flushFrame()
    expect(rail.result.current.attentionReviewCommentId).toBe('last')
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(900))
    expect(rail.result.current.attentionReviewCommentId).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
