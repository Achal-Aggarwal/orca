import { useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import type { AppState } from '@/store'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { richMarkdownAnnotationHighlightPluginKey } from './rich-markdown-annotation-highlight'
import { updateRichMarkdownAnnotationHighlightsAfterSubmit } from './rich-markdown-annotation-submit-highlights'
import {
  clampRichMarkdownAnnotationTarget,
  getRichMarkdownAnnotationTarget,
  hasRichMarkdownCommentForRange,
  type RichMarkdownAnnotationTarget
} from './rich-markdown-review-annotations'
import { flushPendingProseMirrorSelection } from './rich-markdown-selection-flush'

export function useRichMarkdownReviewAnnotationActions({
  addDiffComment,
  annotationPopover,
  annotationPopoverRef,
  annotationTarget,
  canAnnotateRichMarkdown,
  clearAnnotationHighlight,
  editorRef,
  markdownComments,
  markdownSourceLineOffset,
  rootRef,
  setAnnotationPopover,
  setAnnotationTarget,
  setReviewRailOpen,
  sourceRelativePath,
  worktreeId
}: {
  addDiffComment: AppState['addDiffComment']
  annotationPopover: RichMarkdownAnnotationTarget | null
  annotationPopoverRef: MutableRefObject<RichMarkdownAnnotationTarget | null>
  annotationTarget: RichMarkdownAnnotationTarget | null
  canAnnotateRichMarkdown: boolean
  clearAnnotationHighlight: () => void
  editorRef: MutableRefObject<Editor | null>
  markdownComments: DiffComment[]
  markdownSourceLineOffset: number
  rootRef: MutableRefObject<HTMLDivElement | null>
  setAnnotationPopover: (target: RichMarkdownAnnotationTarget | null) => void
  setAnnotationTarget: (target: RichMarkdownAnnotationTarget | null) => void
  setReviewRailOpen: (open: boolean) => void
  sourceRelativePath: string | null
  worktreeId: string
}) {
  const submitAnnotation = useCallback(
    async (body: string): Promise<void> => {
      if (!annotationPopover || sourceRelativePath === null) {
        return
      }
      const result = await addDiffComment({
        worktreeId,
        filePath: sourceRelativePath,
        source: 'markdown',
        startLine:
          annotationPopover.startLine === undefined
            ? undefined
            : annotationPopover.startLine + markdownSourceLineOffset,
        lineNumber: annotationPopover.lineNumber + markdownSourceLineOffset,
        selectedText: annotationPopover.selectedText,
        body,
        side: 'modified'
      })
      if (!result) {
        console.error('Failed to add markdown comment — draft preserved')
        return
      }
      updateRichMarkdownAnnotationHighlightsAfterSubmit({
        annotationPopover,
        comments: [...markdownComments, result],
        editor: editorRef.current,
        markdownSourceLineOffset
      })
      setAnnotationPopover(null)
      clearAnnotationHighlight()
      window.getSelection()?.removeAllRanges()
    },
    [
      addDiffComment,
      annotationPopover,
      clearAnnotationHighlight,
      editorRef,
      markdownComments,
      markdownSourceLineOffset,
      setAnnotationPopover,
      sourceRelativePath,
      worktreeId
    ]
  )

  // Report opened/retained composers so keyboard callers consume only handled chords.
  const openAnnotationPopover = useCallback(
    (requireLiveSelection = false): boolean => {
      if (!canAnnotateRichMarkdown) {
        return false
      }
      // Consume repeated open requests without remounting a composer and losing its draft.
      if (annotationPopoverRef.current) {
        return true
      }
      const editor = editorRef.current
      const root = rootRef.current
      // Flush native mouse selection before choosing the target; a chord can precede ProseMirror’s selection sync.
      if (editor) {
        flushPendingProseMirrorSelection(editor)
      }
      // Keyboard actions need live targets; mouse buttons may use the target their render exposed.
      const liveTarget = editor && root ? getRichMarkdownAnnotationTarget(editor, root) : null
      const baseTarget = liveTarget ?? (requireLiveSelection ? null : annotationTarget)
      if (!baseTarget) {
        return false
      }
      const target = editor ? clampRichMarkdownAnnotationTarget(editor, baseTarget) : baseTarget
      if (
        !target ||
        hasRichMarkdownCommentForRange(markdownComments, target, markdownSourceLineOffset)
      ) {
        setAnnotationTarget(null)
        return false
      }
      editor?.view.dispatch(
        editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, {
          activeRange: { from: target.from, to: target.to }
        })
      )
      // Claim the draft before setState so same-tick chords/repeats cannot remount it and discard typing.
      annotationPopoverRef.current = target
      // Why: opening a draft should reserve the notes rail immediately; saved notes stay visible.
      setReviewRailOpen(true)
      setAnnotationPopover(target)
      setAnnotationTarget(null)
      return true
    },
    [
      annotationPopoverRef,
      annotationTarget,
      canAnnotateRichMarkdown,
      editorRef,
      markdownComments,
      markdownSourceLineOffset,
      rootRef,
      setAnnotationPopover,
      setAnnotationTarget,
      setReviewRailOpen
    ]
  )

  return { openAnnotationPopover, submitAnnotation }
}
