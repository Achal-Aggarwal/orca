// @vitest-environment happy-dom
import React, { useLayoutEffect, useRef, useState } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { DiffOnMount } from '@monaco-editor/react'
import { installDiffSectionHeightMeasurement } from './diff-section-height-measurement'
import { DiffSectionBody } from './DiffSectionBody'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  getCombinedDiffRenderRange,
  getFocusedCombinedDiffSectionIndex
} from './combined-diff/scroll-viewport/combined-diff-render-range'
import { useCombinedDiffScrollPersistence } from './combined-diff/scroll-viewport/use-combined-diff-scroll-persistence'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import {
  claimCombinedDiffView,
  readCombinedDiffViewMemory,
  releaseCombinedDiffView
} from './combined-diff/remember-view/combined-diff-view-cache'

// Happy DOM has no canvas adapter; drawing does not participate in cursor geometry.
const canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => ({
    clearRect() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {}
  })
})
afterAll(() => Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', canvasContext))
let diff: monaco.editor.IStandaloneDiffEditor
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({
    onMount,
    options
  }: {
    onMount: DiffOnMount
    options: monaco.editor.IDiffEditorConstructionOptions
  }) => {
    const ref = useRef<HTMLDivElement>(null)
    const initial = useRef({ onMount, options })
    useLayoutEffect(() => {
      if (!ref.current) {
        throw new Error('Missing editor host')
      }
      diff = monaco.editor.createDiffEditor(ref.current, {
        ...initial.current.options,
        automaticLayout: false,
        dimension: { width: 1000, height: 500 },
        lineHeight: 20,
        fontSize: 13,
        renderSideBySideInlineBreakpoint: 0
      })
      initial.current.onMount(diff, monaco)
      return () => diff.dispose()
    }, [])
    return <div ref={ref} />
  }
}))

const disposers: (() => void)[] = []
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})
const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

async function fixture(sideBySide: boolean) {
  const outer = document.createElement('div')
  outer.className = 'combined-diff-scroll-container'
  document.body.append(outer)
  let scrollTop = 1000
  let scrollFrame = 0
  let height = 500
  Object.defineProperties(outer, {
    clientHeight: { value: 300 },
    scrollHeight: { get: () => 49_500 + height + 30 },
    offsetHeight: { value: 300 },
    offsetWidth: { value: 1000 },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, 49_500 + height + 30 - 300))
        cancelAnimationFrame(scrollFrame)
        scrollFrame = requestAnimationFrame(() => outer.dispatchEvent(new Event('scroll')))
      }
    }
  })
  outer.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 300)
  outer.getClientRects = () =>
    Object.assign([outer.getBoundingClientRect()], { item: () => outer.getBoundingClientRect() })
  const section = {
    key: 'tail',
    path: 'tail.ts',
    status: 'modified' as const,
    collapsed: false,
    loading: false,
    dirty: false,
    diffResult: null,
    largeDiffRenderLimit: null,
    originalContent: '',
    modifiedContent: ''
  }
  function Rows() {
    const [bodyHeight, setBodyHeight] = useState(500)
    const estimateSize = (index: number): number => (index === 2 ? bodyHeight + 30 : 500)
    const virtualizer = useVirtualizer({
      count: 100,
      getScrollElement: () => outer,
      estimateSize,
      initialOffset: 1000,
      initialRect: { width: 1000, height: 300 },
      rangeExtractor: (range) =>
        getCombinedDiffRenderRange(
          range,
          estimateSize,
          300,
          getFocusedCombinedDiffSectionIndex(outer)
        )
    })
    useLayoutEffect(() => {
      height = bodyHeight
      virtualizer.measure()
      diff?.layout({ width: 1000, height })
    }, [bodyHeight, virtualizer])
    const mount: DiffOnMount = (editor) => {
      disposers.push(installDiffSectionHeightMeasurement(editor, setBodyHeight))
    }
    return virtualizer.getVirtualItems().some((item) => item.index === 2) ? (
      <div data-index={2} data-combined-diff-section-row>
        <div data-combined-diff-section-header />
        <DiffSectionBody
          section={section}
          index={2}
          sectionBodyHeight={bodyHeight}
          useIntrinsicImageHeight={false}
          isBranchMode={false}
          sideBySide={sideBySide}
          isDark={false}
          language="plaintext"
          modelPathBase="cursor-reveal"
          isEditable={false}
          diffEditorFontSize={13}
          diffWordWrap
          onRetrySection={() => {}}
          onLoadDeferredSection={() => {}}
          onSaveLimitedDiff={() => {}}
          onMount={mount}
        />
      </div>
    ) : null
  }
  const view = render(<Rows />, { container: outer })
  const header = outer.querySelector<HTMLElement>('[data-combined-diff-section-header]')!
  header.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 30)
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'wrapped content '.repeat(20)}`)
  const original = monaco.editor.createModel(lines.join('\n'))
  lines[10] = 'changed'
  const modified = monaco.editor.createModel(lines.join('\n'))
  disposers.push(() => {
    original.dispose()
    modified.dispose()
  })
  for (const pane of [diff.getOriginalEditor(), diff.getModifiedEditor()]) {
    const host = pane.getContainerDomNode()
    host.getBoundingClientRect = () => new DOMRect(0, 1030 - scrollTop, 500, height)
    host.getClientRects = () =>
      Object.assign([host.getBoundingClientRect()], { item: () => host.getBoundingClientRect() })
  }
  const root = diff.getContainerDomNode()
  root.getClientRects = () =>
    Object.assign([new DOMRect(0, 1030 - scrollTop, 1000, height)], { item: () => null })
  diff.setModel({ original, modified })
  await vi.waitFor(() => expect(diff.getLineChanges()).not.toBeNull())
  disposers.push(() => cancelAnimationFrame(scrollFrame))
  for (let index = 0; index < 4; index++) {
    await act(frame)
  }
  return {
    outer,
    view,
    measuredHeight: () => height,
    settle: async () => {
      for (let index = 0; index < 4; index++) {
        await act(frame)
      }
    }
  }
}

const modes = [true, false].flatMap((split) =>
  [true, false].map((original) => ({ split, original }))
)
it.each(modes)(
  'reveals arrow navigation (split=$split, original=$original) and preserves mouse/API positions',
  async ({ split, original }) => {
    const { outer, settle } = await fixture(split)
    diff.updateOptions({ hideUnchangedRegions: { enabled: false } })
    await settle()
    for (const pane of [original ? diff.getOriginalEditor() : diff.getModifiedEditor()]) {
      pane.focus()
      pane.setPosition({ lineNumber: 12, column: 1 })
      outer.scrollTop = 1000
      for (let i = 0; i < 30; i++) {
        pane.trigger('keyboard', 'cursorDown', null)
      }
      await settle()
      const position = pane.getPosition()!
      const cursor = pane.getScrolledVisiblePosition(position)!
      const top = pane.getContainerDomNode().getBoundingClientRect().top + cursor.top
      expect(top).toBeGreaterThanOrEqual(30)
      expect(top + cursor.height).toBeLessThanOrEqual(300)
      const mounted = diff
      for (const command of ['cursorPageDown', 'cursorPageUp']) {
        pane.trigger('keyboard', command, null)
        await settle()
        const cursor = pane.getScrolledVisiblePosition(pane.getPosition()!)!
        const top = pane.getContainerDomNode().getBoundingClientRect().top + cursor.top
        expect(top).toBeGreaterThanOrEqual(30)
        expect(top + cursor.height).toBeLessThanOrEqual(300)
        expect(diff).toBe(mounted)
      }
      const offset = outer.scrollTop
      pane.setPosition({ lineNumber: 1, column: 1 }, 'mouse')
      await settle()
      expect(outer.scrollTop).toBe(offset)
      for (const source of ['api', 'code.jump']) {
        pane.setPosition({ lineNumber: 300, column: 1 }, source)
        await settle()
        expect(outer.scrollTop).toBe(offset)
      }
      pane.trigger('keyboard', 'cursorTop', null)
      await settle()
      const topCursor = pane.getScrolledVisiblePosition(pane.getPosition()!)!
      const topAfterUp = pane.getContainerDomNode().getBoundingClientRect().top + topCursor.top
      expect(topAfterUp).toBeGreaterThanOrEqual(30)
      expect(topAfterUp + topCursor.height).toBeLessThanOrEqual(300)
    }
  }
)

it.each(modes)(
  'retains the focused nonfinal section before hidden-tail geometry settles (split=$split, original=$original)',
  async ({ split, original }) => {
    const { outer, measuredHeight, settle } = await fixture(split)
    for (const pane of [original ? diff.getOriginalEditor() : diff.getModifiedEditor()]) {
      pane.focus()
      pane.setPosition({ lineNumber: 12, column: 1 })
      outer.scrollTop = 1000
      const before = pane.getContentHeight()
      const extent = measuredHeight()
      const mounted = diff
      const disposed = vi.fn()
      pane.onDidDispose(disposed)
      expect(outer.contains(document.activeElement)).toBe(true)
      await act(async () => {
        pane.trigger('keyboard', 'cursorBottom', null)
        expect(measuredHeight()).toBe(extent)
        if (original) {
          expect(outer.scrollTop).toBeGreaterThan(1030 + extent)
        }
        // Scroll reaches the real virtualizer before its deferred section-height commit.
        outer.dispatchEvent(new Event('scroll'))
      })
      expect(disposed).not.toHaveBeenCalled()
      await settle()
      expect(pane.getPosition()?.lineNumber).toBe(300)
      expect(pane.getContentHeight()).toBeGreaterThan(before)
      const cursor = pane.getScrolledVisiblePosition(pane.getPosition()!)!
      const top = pane.getContainerDomNode().getBoundingClientRect().top + cursor.top
      expect(top).toBeGreaterThanOrEqual(30)
      expect(top + cursor.height).toBeLessThanOrEqual(300)
      expect(diff).toBe(mounted)
      expect(diff.getModel()).not.toBeNull()
    }
  }
)

it('records a delayed, coalesced keyboard reveal as a new user scroll anchor', async () => {
  const { outer, settle } = await fixture(true)
  diff.updateOptions({ hideUnchangedRegions: { enabled: false } })
  await settle()
  const lease = claimCombinedDiffView('cursor-persistence', 'cursor-workspace')
  disposers.push(() => releaseCombinedDiffView(lease))
  const recordVirtualScrollAnchor = vi.fn()
  const writeScrollAnchor = vi.fn()
  const offset = { current: 1000 }
  renderHook(() =>
    useCombinedDiffScrollPersistence({
      anchors: {
        recordVirtualScrollAnchor,
        writeScrollAnchor,
        persistScrollAnchor: vi.fn(),
        scrollToSectionIndex: vi.fn(),
        recordDomScrollAnchor: () => false
      },
      entrySignature: 'tail',
      hasDirectScrollInput: () => false,
      latestDomScrollAnchorRef: { current: null },
      scrollAnchorRef: { current: null },
      memoryLeaseRef: { current: lease },
      programmaticScrollMarks: createProgrammaticScrollMarks(),
      scrollContainerRef: { current: outer },
      scrollOffsetRef: offset,
      sectionCount: 3,
      sectionHeights: {},
      sections: [],
      setClampRestoreCount: vi.fn(),
      updateScrollbar: vi.fn(),
      viewStateKey: 'cursor-persistence'
    })
  )
  const pane = diff.getModifiedEditor()
  pane.focus()
  pane.trigger('keyboard', 'cursorBottom', null)
  await settle()
  expect(outer.scrollTop).toBeGreaterThan(1000)
  expect(recordVirtualScrollAnchor).toHaveBeenLastCalledWith(outer.scrollTop)
  expect(writeScrollAnchor).toHaveBeenCalled()
  expect(offset.current).toBe(outer.scrollTop)
  expect(readCombinedDiffViewMemory('cursor-persistence')?.scrollTop).toBe(outer.scrollTop)
})

it('yields settled visibility to manual scrolling, and cancels work when disposed', async () => {
  const { outer, view, settle } = await fixture(true)
  diff.updateOptions({ hideUnchangedRegions: { enabled: false } })
  await settle()
  const pane = diff.getModifiedEditor()
  pane.focus()
  pane.trigger('keyboard', 'cursorBottom', null)
  await settle()
  outer.dispatchEvent(new WheelEvent('wheel'))
  outer.scrollTop = 1000
  diff.layout({ width: 999, height: pane.getContentHeight() })
  await settle()
  expect(outer.scrollTop).toBe(1000)
  const geometry = vi.spyOn(pane, 'getScrolledVisiblePosition').mockReturnValue(null)
  pane.trigger('keyboard', 'cursorTop', null)
  await settle()
  expect(outer.scrollTop).toBe(1000)
  geometry.mockRestore()
  pane.trigger('keyboard', 'cursorBottom', null)
  view.unmount()
  const offset = outer.scrollTop
  await settle()
  expect(outer.scrollTop).toBe(offset)
})

it('measures an original-only content-height change after settlement', async () => {
  const { measuredHeight, settle } = await fixture(true)
  diff.updateOptions({ hideUnchangedRegions: { enabled: false } })
  await settle()
  const original = diff.getOriginalEditor()
  const modifiedHeight = diff.getModifiedEditor().getContentHeight()
  original.updateOptions({ padding: { bottom: 40_000 } })
  await settle()
  expect(diff.getModifiedEditor().getContentHeight()).toBe(modifiedHeight)
  expect(original.getContentHeight()).toBeGreaterThan(modifiedHeight)
  expect(measuredHeight()).toBe(original.getContentHeight())
})
