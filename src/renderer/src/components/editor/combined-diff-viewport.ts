export const combinedDiffViewportAttributes = { 'data-combined-diff-viewport': '' } as const
export const combinedDiffRowAttributes = { 'data-combined-diff-section-row': '' } as const
export const combinedDiffHeaderAttributes = { 'data-combined-diff-section-header': '' } as const
export const COMBINED_DIFF_VIEWPORT_SELECTOR = '[data-combined-diff-viewport]'
export const COMBINED_DIFF_ROW_SELECTOR = '[data-combined-diff-section-row]'
export const COMBINED_DIFF_HEADER_SELECTOR = '[data-combined-diff-section-header]'
export const COMBINED_DIFF_DIRECT_INPUT_EVENT = 'combined-diff-direct-input'

export function notifyCombinedDiffDirectInput(viewport: HTMLElement | null): void {
  viewport?.dispatchEvent(new Event(COMBINED_DIFF_DIRECT_INPUT_EVENT))
}
