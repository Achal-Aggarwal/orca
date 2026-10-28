import { useCallback, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { copyMarkdownReviewNotesForAgent } from '@/lib/markdown-review-note-copy'
import type { MarkdownReviewNote } from '@/lib/markdown-review-notes'

type UseRichMarkdownReviewCopyFeedbackOptions = {
  markdownReviewContent: string
  markdownReviewNotes: MarkdownReviewNote[]
  rootRef: MutableRefObject<HTMLDivElement | null>
}

export function useRichMarkdownReviewCopyFeedback({
  markdownReviewContent,
  markdownReviewNotes,
  rootRef
}: UseRichMarkdownReviewCopyFeedbackOptions) {
  const [reviewNotesCopied, setReviewNotesCopied] = useState(false)
  const [copiedReviewNoteId, setCopiedReviewNoteId] = useState<string | null>(null)
  const { reviewNotesCopiedResetTimerRef, copiedReviewNoteResetTimerRef, clearReviewCopyTimers } =
    useRichMarkdownReviewCopyTimers()

  const handleCopyMarkdownReviewNotes = useCallback(async (): Promise<void> => {
    const copied = await copyReviewNotes(markdownReviewNotes, markdownReviewContent)
    if (copied && rootRef.current) {
      clearReviewCopyTimers()
      setCopiedReviewNoteId(null)
      setReviewNotesCopied(true)
      reviewNotesCopiedResetTimerRef.current = window.setTimeout(() => {
        reviewNotesCopiedResetTimerRef.current = null
        setReviewNotesCopied(false)
      }, 1600)
    }
  }, [
    clearReviewCopyTimers,
    markdownReviewContent,
    markdownReviewNotes,
    reviewNotesCopiedResetTimerRef,
    rootRef
  ])

  const handleCopyMarkdownReviewNote = useRichMarkdownReviewNoteCopy({
    markdownReviewContent,
    rootRef,
    copiedReviewNoteResetTimerRef,
    setCopiedReviewNoteId
  })

  return {
    clearReviewCopyTimers,
    copiedReviewNoteId,
    handleCopyMarkdownReviewNote,
    handleCopyMarkdownReviewNotes,
    reviewNotesCopied
  }
}

function useRichMarkdownReviewCopyTimers() {
  const reviewNotesCopiedResetTimerRef = useRef<number | null>(null)
  const copiedReviewNoteResetTimerRef = useRef<number | null>(null)
  const clearReviewCopyTimers = useCallback((): void => {
    clearWindowTimer(reviewNotesCopiedResetTimerRef)
    clearWindowTimer(copiedReviewNoteResetTimerRef)
  }, [])
  return { reviewNotesCopiedResetTimerRef, copiedReviewNoteResetTimerRef, clearReviewCopyTimers }
}

function useRichMarkdownReviewNoteCopy({
  markdownReviewContent,
  rootRef,
  copiedReviewNoteResetTimerRef,
  setCopiedReviewNoteId
}: {
  markdownReviewContent: string
  rootRef: MutableRefObject<HTMLDivElement | null>
  copiedReviewNoteResetTimerRef: MutableRefObject<number | null>
  setCopiedReviewNoteId: Dispatch<SetStateAction<string | null>>
}) {
  return useCallback(
    async (note: MarkdownReviewNote): Promise<void> => {
      const copied = await copyReviewNotes([note], markdownReviewContent)
      if (copied && rootRef.current) {
        clearWindowTimer(copiedReviewNoteResetTimerRef)
        setCopiedReviewNoteId(note.id)
        copiedReviewNoteResetTimerRef.current = window.setTimeout(() => {
          copiedReviewNoteResetTimerRef.current = null
          setCopiedReviewNoteId(null)
        }, 1600)
      }
    },
    [copiedReviewNoteResetTimerRef, markdownReviewContent, rootRef, setCopiedReviewNoteId]
  )
}

function clearWindowTimer(ref: MutableRefObject<number | null>): void {
  if (ref.current !== null) {
    window.clearTimeout(ref.current)
    ref.current = null
  }
}

async function copyReviewNotes(notes: MarkdownReviewNote[], content: string): Promise<boolean> {
  try {
    return await copyMarkdownReviewNotesForAgent({
      notes,
      content,
      writeClipboardText: window.api.ui.writeClipboardText
    })
  } catch {
    return false
  }
}
