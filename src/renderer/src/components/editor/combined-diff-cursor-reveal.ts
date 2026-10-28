import type { editor } from 'monaco-editor'
import {
  COMBINED_DIFF_VIEWPORT_SELECTOR,
  COMBINED_DIFF_ROW_SELECTOR,
  COMBINED_DIFF_HEADER_SELECTOR,
  COMBINED_DIFF_DIRECT_INPUT_EVENT
} from './combined-diff-viewport'
import { hasLayoutBox } from '@/hooks/virtualized-hidden-row-measurement'

export function installCombinedDiffCursorReveal(diff: editor.IStandaloneDiffEditor): () => void {
  const root = diff.getContainerDomNode()
  const viewport = root.closest<HTMLElement>(COMBINED_DIFF_VIEWPORT_SELECTOR)
  if (!viewport) {
    return () => {}
  }
  const header = root
    .closest(COMBINED_DIFF_ROW_SELECTOR)
    ?.querySelector<HTMLElement>(COMBINED_DIFF_HEADER_SELECTOR)
  let active: editor.ICodeEditor | null = null
  let frame: number | null = null
  const clear = (): void => {
    active = null
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
  }
  const reveal = (): void => {
    const position = active?.getPosition()
    const node = active?.getContainerDomNode()
    if (!active || !position || !node || !hasLayoutBox(node) || !hasLayoutBox(viewport)) {
      return
    }
    const cursor = active.getScrolledVisiblePosition(position)
    if (!cursor) {
      return
    }
    const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop
    const top = node.getBoundingClientRect().top + cursor.top
    const visibleTop = viewportTop + (header?.getBoundingClientRect().height ?? 0)
    const visibleBottom = viewportTop + viewport.clientHeight
    const delta =
      top < visibleTop ? top - visibleTop : Math.max(0, top + cursor.height - visibleBottom)
    // Keyboard reveals are user intent; unmarked scrolls update the existing outer anchor.
    if (delta !== 0) {
      viewport.scrollTop += delta
    }
  }
  const scheduleReveal = (): void => {
    if (active && frame === null) {
      frame = requestAnimationFrame(() => {
        frame = null
        reveal()
      })
    }
  }
  const subscriptions = [diff.getOriginalEditor(), diff.getModifiedEditor()].flatMap((pane) => [
    pane.onDidChangeCursorPosition((event) => {
      clear()
      if (event.source === 'keyboard') {
        active = pane
        reveal()
        scheduleReveal()
      }
    }),
    // Hidden-region expansion and deferred section sizing can change visibility after the cursor event.
    pane.onDidLayoutChange(scheduleReveal),
    pane.onDidScrollChange(scheduleReveal),
    pane.onDidBlurEditorText(clear)
  ])
  subscriptions.push(diff.onDidContentSizeChange(scheduleReveal))
  viewport.addEventListener(COMBINED_DIFF_DIRECT_INPUT_EVENT, clear)
  const directInputs = ['pointerdown', 'wheel', 'touchmove'] as const
  for (const event of directInputs) {
    viewport.addEventListener(event, clear, { capture: true, passive: true })
  }
  return () => {
    clear()
    viewport.removeEventListener(COMBINED_DIFF_DIRECT_INPUT_EVENT, clear)
    subscriptions.forEach((subscription) => subscription.dispose())
    for (const event of directInputs) {
      viewport.removeEventListener(event, clear, true)
    }
  }
}
