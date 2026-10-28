import type { editor } from 'monaco-editor'
import { hasLayoutBox } from '@/hooks/virtualized-hidden-row-measurement'

export function installDiffSectionHeightMeasurement(
  diff: editor.IStandaloneDiffEditor,
  onHeight: (height: number) => void
): () => void {
  // Initial full-file measurements precede hidden-region layout and move virtualized rows.
  let ready = false
  let frame: number | null = null
  const requestHeight = (): void => {
    if (!ready || frame !== null) {
      return
    }
    frame = requestAnimationFrame(() => {
      frame = null
      // Zero-width split editors fall back to inline and report an incorrect taller height.
      if (hasLayoutBox(diff.getContainerDomNode())) {
        onHeight(
          Math.max(
            diff.getOriginalEditor().getContentHeight(),
            diff.getModifiedEditor().getContentHeight()
          )
        )
      }
    })
  }
  const markReady = (): void => {
    ready = true
    requestHeight()
  }
  const size = diff.onDidContentSizeChange(requestHeight)
  const update = diff.onDidUpdateDiff(markReady)
  if (diff.getLineChanges() !== null) {
    markReady()
  }
  return () => {
    size.dispose()
    update.dispose()
    if (frame !== null) {
      cancelAnimationFrame(frame)
    }
  }
}
