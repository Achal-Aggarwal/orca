import { formatMarkdownReviewNotes, type MarkdownReviewNote } from './markdown-review-notes'

export type MarkdownReviewNoteClipboardWriter = (text: string) => Promise<void>

export async function copyMarkdownReviewNotesForAgent({
  notes,
  content,
  writeClipboardText
}: {
  notes: readonly MarkdownReviewNote[]
  content: string
  writeClipboardText: MarkdownReviewNoteClipboardWriter
}): Promise<boolean> {
  if (notes.length === 0) {
    return false
  }

  return writeClipboardText(formatMarkdownReviewNotes(notes, content)).then(() => true)
}
