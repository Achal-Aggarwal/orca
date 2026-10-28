// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownAnnotationHighlightExtension } from './rich-markdown-annotation-highlight'
import { useRichMarkdownReviewRailController } from './useRichMarkdownReviewRailController'
import type { DiffComment } from '../../../../shared/diff-comment-types'
const frames = new Map<number, FrameRequestCallback>(),
  editors: Editor[] = []
let serial = 0
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = ++serial
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
})
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
function makeEditor(): Editor {
  const editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: [StarterKit, createRichMarkdownAnnotationHighlightExtension()],
    content: '<p>selected body</p>'
  })
  editor.view.coordsAtPos = () => ({ left: 0, right: 1, top: 0, bottom: 1 })
  editors.push(editor)
  vi.runOnlyPendingTimers()
  return editor
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

function mountPositioningRail(editor: Editor, markdownComments: DiffComment[] = [comment]) {
  const container = document.createElement('div')
  const editorRef = { current: editor }
  const markdownSourceLineOffsetRef = { current: 0 }
  const scrollContainerRef = { current: container }
  let options = {
    canAnnotateRichMarkdown: true,
    content: 'selected body',
    editorRef,
    markdownComments,
    markdownSourceLineOffset: 0,
    markdownSourceLineOffsetRef,
    scrollContainerRef
  }
  const hook = renderHook((next) => useRichMarkdownReviewRailController(next), {
    initialProps: options
  })
  return {
    ...hook,
    container,
    update(updates: Partial<typeof options>): void {
      options = { ...options, ...updates }
      markdownSourceLineOffsetRef.current = options.markdownSourceLineOffset
      hook.rerender(options)
    }
  }
}

describe('rich review rail queued positions', () => {
  it('renders current notes when comments change before a queued frame', () => {
    const rail = mountPositioningRail(makeEditor())
    act(() => rail.result.current.setReviewRailOpen(true))
    act(() => rail.update({ markdownComments: [{ ...comment, id: 'latest-note' }] }))
    expect(frames.size).toBe(1)
    flushFrame()
    expect(rail.result.current.notePositions.map((position) => position.comment.id)).toEqual([
      'latest-note'
    ])
  })

  it('uses the current source offset when it changes before a queued frame', () => {
    const rail = mountPositioningRail(makeEditor(), [{ ...comment, lineNumber: 3 }])
    act(() => rail.result.current.setReviewRailOpen(true))
    act(() => rail.update({ markdownSourceLineOffset: 2 }))
    expect(frames.size).toBe(1)
    flushFrame()
    expect(rail.result.current.notePositions.map((position) => position.comment.id)).toEqual([
      comment.id
    ])
  })

  it.each(['hidden', 'disabled', 'removed'] as const)(
    'does not restore note positions after the rail becomes %s',
    (boundary) => {
      const rail = mountPositioningRail(makeEditor())
      act(() => rail.result.current.setReviewRailOpen(true))
      act(() => {
        if (boundary === 'hidden') {
          rail.result.current.setReviewRailOpen(false)
        } else if (boundary === 'disabled') {
          rail.update({ canAnnotateRichMarkdown: false })
        } else {
          rail.update({ markdownComments: [] })
        }
      })
      flushFrame()
      expect(rail.result.current.notePositions).toEqual([])
      expect(frames.size).toBe(0)
    }
  )

  it('coalesces rapid updates and scroll/resize into one current-note frame', () => {
    const rail = mountPositioningRail(makeEditor())
    act(() => rail.result.current.setReviewRailOpen(true))
    act(() => rail.update({ markdownComments: [{ ...comment, id: 'second-note' }] }))
    act(() => rail.update({ markdownComments: [{ ...comment, id: 'third-note' }] }))
    act(() => {
      for (let event = 0; event < 10; event++) {
        rail.container.dispatchEvent(new Event('scroll'))
        window.dispatchEvent(new Event('resize'))
      }
    })
    expect(frames.size).toBe(1)
    flushFrame()
    expect(rail.result.current.notePositions.map((position) => position.comment.id)).toEqual([
      'third-note'
    ])
    expect(frames.size).toBe(0)
  })

  it('cancels queued note positions on unmount', () => {
    const rail = mountPositioningRail(makeEditor())
    act(() => rail.result.current.setReviewRailOpen(true))
    expect(frames.size).toBe(1)
    rail.unmount()
    expect(frames.size).toBe(0)
    flushFrame()
    expect(frames.size).toBe(0)
  })
})
