import { useCallback, useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { Editor } from '@tiptap/react'
import { clearRichMarkdownNotePositions } from './rich-markdown-review-annotations'
import type { RichMarkdownReviewNotePosition } from './rich-markdown-review-note-layout'
import { measureRichMarkdownReviewNotePositions } from './rich-markdown-review-note-positioning'
import type { DiffComment } from '../../../../shared/diff-comment-types'

export function useRichMarkdownReviewNotePositions({
  canAnnotateRichMarkdown,
  content,
  editorRef,
  markdownComments,
  markdownSourceLineOffset,
  notePositionsFrameRef,
  reviewRailVisible,
  scrollContainerRef,
  setNotePositions
}: {
  canAnnotateRichMarkdown: boolean
  content: string
  editorRef: MutableRefObject<Editor | null>
  markdownComments: DiffComment[]
  markdownSourceLineOffset: number
  notePositionsFrameRef: MutableRefObject<number | null>
  reviewRailVisible: boolean
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>
  setNotePositions: Dispatch<SetStateAction<RichMarkdownReviewNotePosition[]>>
}) {
  const syncNotePositions = useCallback((): void => {
    const editor = editorRef.current
    const container = scrollContainerRef.current
    if (
      !reviewRailVisible ||
      !canAnnotateRichMarkdown ||
      !editor ||
      !container ||
      markdownComments.length === 0
    ) {
      clearRichMarkdownNotePositions(setNotePositions)
      return
    }
    setNotePositions(
      measureRichMarkdownReviewNotePositions({
        editor,
        container,
        markdownComments,
        markdownSourceLineOffset
      })
    )
  }, [
    canAnnotateRichMarkdown,
    editorRef,
    markdownComments,
    markdownSourceLineOffset,
    reviewRailVisible,
    scrollContainerRef,
    setNotePositions
  ])

  const requestSyncNotePositions = useCallback((): void => {
    if (!reviewRailVisible) {
      clearRichMarkdownNotePositions(setNotePositions)
      return
    }
    if (notePositionsFrameRef.current !== null) {
      return
    }
    notePositionsFrameRef.current = window.requestAnimationFrame(() => {
      notePositionsFrameRef.current = null
      syncNotePositions()
    })
  }, [notePositionsFrameRef, reviewRailVisible, setNotePositions, syncNotePositions])

  useEffect(() => requestSyncNotePositions(), [content, markdownComments, requestSyncNotePositions])

  useEffect(() => {
    if (!reviewRailVisible) {
      clearRichMarkdownNotePositions(setNotePositions)
      return
    }
    const container = scrollContainerRef.current
    if (!container) {
      return
    }
    const update = (): void => requestSyncNotePositions()
    container.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    requestSyncNotePositions()
    return () => {
      container.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [requestSyncNotePositions, reviewRailVisible, scrollContainerRef, setNotePositions])

  return syncNotePositions
}
