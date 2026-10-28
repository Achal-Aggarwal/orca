import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import type { AppState } from '@/store'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { updateRichMarkdownAnnotationHighlightsAfterSubmit } from './rich-markdown-annotation-submit-highlights'
import type { RichMarkdownAnnotationTarget } from './rich-markdown-review-annotations'

type RichMarkdownAnnotationSubmissionOptions = {
  addDiffComment: AppState['addDiffComment']
  annotationPopover: RichMarkdownAnnotationTarget | null
  annotationPopoverRef: MutableRefObject<RichMarkdownAnnotationTarget | null>
  clearAnnotationHighlight: () => void
  editorRef: MutableRefObject<Editor | null>
  markdownCommentsRef: MutableRefObject<DiffComment[]>
  markdownSourceLineOffset: number
  rootRef: MutableRefObject<HTMLDivElement | null>
  setAnnotationPopover: (target: RichMarkdownAnnotationTarget | null) => void
  sourceRelativePath: string | null
  worktreeId: string
}

type PendingRichMarkdownAnnotationSubmission = {
  complete: ((result: DiffComment) => void) | null
}

export function useRichMarkdownAnnotationSubmission({
  addDiffComment,
  annotationPopover,
  annotationPopoverRef,
  clearAnnotationHighlight,
  editorRef,
  markdownCommentsRef,
  markdownSourceLineOffset,
  rootRef,
  setAnnotationPopover,
  sourceRelativePath,
  worktreeId
}: RichMarkdownAnnotationSubmissionOptions) {
  const pendingAnnotationSubmissionsRef =
    useRef<Set<PendingRichMarkdownAnnotationSubmission> | null>(null)
  const clearPendingAnnotationSubmissions = useCallback((): void => {
    const pending = pendingAnnotationSubmissionsRef.current
    if (pending) {
      for (const submission of pending) {
        submission.complete = null
      }
      pending.clear()
      pendingAnnotationSubmissionsRef.current = null
    }
  }, [])
  useEffect(() => clearPendingAnnotationSubmissions, [clearPendingAnnotationSubmissions])

  const submitAnnotation = useCallback(
    (body: string): Promise<void> => {
      if (!annotationPopover || sourceRelativePath === null) {
        return Promise.resolve()
      }
      const submittedEditor = editorRef.current
      const submittedRoot = rootRef.current
      const editorOwner = submittedEditor ? new WeakRef(submittedEditor) : null
      const rootOwner = submittedRoot ? new WeakRef(submittedRoot) : null
      const submission: PendingRichMarkdownAnnotationSubmission = {
        complete: (result) => {
          const editor = editorOwner?.deref()
          const root = rootOwner?.deref()
          if (
            !editor ||
            editor.isDestroyed ||
            editorRef.current !== editor ||
            !root ||
            rootRef.current !== root ||
            annotationPopoverRef.current !== annotationPopover
          ) {
            return
          }
          const currentComments = markdownCommentsRef.current
          updateRichMarkdownAnnotationHighlightsAfterSubmit({
            annotationPopover,
            comments: currentComments.some((comment) => comment.id === result.id)
              ? currentComments
              : [...currentComments, result],
            editor,
            markdownSourceLineOffset
          })
          setAnnotationPopover(null)
          clearAnnotationHighlight()
          window.getSelection()?.removeAllRanges()
        }
      }
      const pending =
        pendingAnnotationSubmissionsRef.current ??
        new Set<PendingRichMarkdownAnnotationSubmission>()
      pendingAnnotationSubmissionsRef.current = pending
      pending.add(submission)
      try {
        return finishRichMarkdownAnnotationSubmission(
          addDiffComment({
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
          }),
          submission,
          pending
        )
      } catch (error) {
        pending.delete(submission)
        submission.complete = null
        return Promise.reject(error)
      }
    },
    [
      addDiffComment,
      annotationPopover,
      annotationPopoverRef,
      clearAnnotationHighlight,
      editorRef,
      markdownCommentsRef,
      markdownSourceLineOffset,
      rootRef,
      setAnnotationPopover,
      sourceRelativePath,
      worktreeId
    ]
  )

  return { clearPendingAnnotationSubmissions, submitAnnotation }
}

async function finishRichMarkdownAnnotationSubmission(
  save: Promise<DiffComment | null>,
  submission: PendingRichMarkdownAnnotationSubmission,
  pending: Set<PendingRichMarkdownAnnotationSubmission>
): Promise<void> {
  try {
    const result = await save
    if (!result) {
      console.error('Failed to add markdown comment — draft preserved')
      return
    }
    submission.complete?.(result)
  } finally {
    pending.delete(submission)
    submission.complete = null
  }
}
