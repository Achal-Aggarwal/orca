import { act, renderHook } from '@testing-library/react'
import { expect, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import type { DiffSection } from './diff-section-types'
import { COMBINED_DIFF_DIRECT_INPUT_EVENT } from './combined-diff-viewport'
import { useCombinedDiffTreeNavigation } from './combined-diff/browse-files/use-combined-diff-tree-navigation'
import { useCombinedDiffDirectScrollInput } from './combined-diff/scroll-viewport/use-combined-diff-direct-scroll-input'

export async function verifyWorktreeTreeTakeover({
  outer,
  section,
  scrollToIndex,
  settle,
  diff,
  operations
}: {
  outer: HTMLDivElement
  section: DiffSection
  scrollToIndex: (index: number) => void
  settle: () => Promise<void>
  diff: editor.IStandaloneDiffEditor
  operations: { bridge: number }
}): Promise<void> {
  const sections = [{ ...section, key: 'combined-branch:destination.ts', path: 'destination.ts' }]
  const notified = vi.fn()
  outer.addEventListener(COMBINED_DIFF_DIRECT_INPUT_EVENT, notified)
  const pane = diff.getModifiedEditor()
  pane.focus()
  const focused = document.activeElement
  const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
  const delegateScroll = vi.fn((index: number) => {
    expect(notified).toHaveBeenCalledTimes(1)
    expect(cancelFrame).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(focused)
    scrollToIndex(index)
  })
  const navigation = renderHook(() => {
    const { markDirectScrollInput } = useCombinedDiffDirectScrollInput({ current: outer })
    return useCombinedDiffTreeNavigation({
      ensureSectionLoaded: vi.fn(),
      entrySignature: 'tree-takeover',
      markDirectScrollInput,
      scrollToIndex: delegateScroll,
      sectionIndexByKey: new Map([[sections[0].key, 0]]),
      sections,
      sectionsRef: { current: sections },
      toggleSection: vi.fn(),
      treeMode: 'all'
    })
  })
  try {
    operations.bridge = 0
    pane.trigger('keyboard', 'cursorBottom', null)
    expect(operations.bridge).toBeGreaterThan(0)
    const before = outer.scrollTop
    cancelFrame.mockClear()
    operations.bridge = 0
    // No pointer event or blur: only the real semantic hook can relinquish this pending reveal.
    act(() =>
      navigation.result.current.handleTreeNavigate({
        path: 'destination.ts',
        status: 'modified',
        added: 1,
        removed: 1
      })
    )
    expect(delegateScroll).toHaveBeenCalledExactlyOnceWith(0)
    expect(navigation.result.current.activeTreeSectionKey).toBe(sections[0].key)
    const destination = outer.scrollTop
    expect(destination).not.toBe(before)
    diff.layout({ width: 999, height: pane.getContentHeight() })
    await settle()
    expect(outer.scrollTop).toBe(destination)
    expect(operations.bridge).toBe(0)
    expect(document.activeElement).toBe(focused)
  } finally {
    cancelFrame.mockRestore()
    navigation.unmount()
    outer.removeEventListener(COMBINED_DIFF_DIRECT_INPUT_EVENT, notified)
  }
}
