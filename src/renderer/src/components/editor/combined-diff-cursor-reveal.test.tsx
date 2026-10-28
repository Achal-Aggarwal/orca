// @vitest-environment happy-dom
import React, { useLayoutEffect, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { DiffOnMount } from '@monaco-editor/react'
import type * as CursorReveal from './combined-diff-cursor-reveal'
import type * as HeightMeasurement from './diff-section-height-measurement'
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

import {
  prFilesDiffScrollTopCache,
  prFilesDiffViewStateCache
} from '../pull-request-page/cache/files-diff-view'
import {
  reviewHostFixture,
  reviewHostComponents,
  installReviewHostResizeObserver
} from './combined-diff-review-host.fixture'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useCombinedDiffScrollbar } from './combined-diff/scroll-viewport/use-combined-diff-scrollbar'
import { useCombinedDiffDirectScrollInput } from './combined-diff/scroll-viewport/use-combined-diff-direct-scroll-input'
import {
  COMBINED_DIFF_DIRECT_INPUT_EVENT,
  notifyCombinedDiffDirectInput
} from './combined-diff-viewport'

// Instrument only the installers' pane reads, excluding Monaco's own geometry/layout work.
const operations = { bridge: 0, heightReads: 0, publications: 0 }
function countPaneReads(
  editor: monaco.editor.IStandaloneDiffEditor,
  method: 'getScrolledVisiblePosition' | 'getContentHeight',
  onRead: () => void
): monaco.editor.IStandaloneDiffEditor {
  return new Proxy(editor, {
    get(target, key) {
      if (key === 'getOriginalEditor' || key === 'getModifiedEditor') {
        return () =>
          new Proxy(target[key](), {
            get(pane, property) {
              const value = Reflect.get(pane, property, pane)
              if (typeof value !== 'function') {
                return value
              }
              return (...args: unknown[]) => {
                if (property === method) {
                  onRead()
                }
                return Reflect.apply(value, pane, args)
              }
            }
          })
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
vi.mock('./combined-diff-cursor-reveal', async (importOriginal) => {
  const actual = await importOriginal<typeof CursorReveal>()
  return {
    ...actual,
    installCombinedDiffCursorReveal: (editor: monaco.editor.IStandaloneDiffEditor) =>
      actual.installCombinedDiffCursorReveal(
        countPaneReads(editor, 'getScrolledVisiblePosition', () => operations.bridge++)
      )
  }
})
vi.mock('./diff-section-height-measurement', async (importOriginal) => {
  const actual = await importOriginal<typeof HeightMeasurement>()
  return {
    ...actual,
    installDiffSectionHeightMeasurement: (
      editor: monaco.editor.IStandaloneDiffEditor,
      onHeight: (height: number) => void
    ) =>
      actual.installDiffSectionHeightMeasurement(
        countPaneReads(editor, 'getContentHeight', () => operations.heightReads++),
        (height) => {
          operations.publications++
          onHeight(height)
        }
      )
  }
})

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
    useLayoutEffect(() => {
      if (reviewHostFixture.configureViewport && ref.current?.parentElement) {
        diff.updateOptions(options)
        diff.layout({
          width: 1000,
          height: Number.parseFloat(ref.current.parentElement.style.height)
        })
      }
    })
    return <div ref={ref} />
  }
}))

const disposers: (() => void)[] = []
afterEach(() => {
  cleanup()
  prFilesDiffScrollTopCache.clear()
  prFilesDiffViewStateCache.clear()
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  reviewHostFixture.configureViewport = undefined
  reviewHostFixture.virtualizer = undefined
  reviewHostFixture.navigateTree = undefined
  reviewHostFixture.toggleSplit = undefined
  vi.unstubAllGlobals()
})
const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

async function fixture(
  sideBySide: boolean,
  rowCount = 100,
  host: 'worktree' | 'page' | 'dialog' = 'worktree'
) {
  const container = document.createElement('div')
  let outer = document.createElement('div')
  outer.className = 'combined-diff-scroll-container'
  outer.setAttribute('data-combined-diff-viewport', '')
  document.body.append(host === 'worktree' ? outer : container)
  let scrollTop = host === 'worktree' ? 1000 : 0
  let scrollFrame = 0
  let height = 500
  let added = vi.spyOn(outer, 'addEventListener')
  let removed = vi.spyOn(outer, 'removeEventListener')
  const totalHeight = () =>
    host === 'worktree'
      ? (rowCount - 1) * 500 + height + 30
      : Number.parseFloat(
          outer.firstElementChild?.getAttribute('style')?.match(/height: ([\d.]+)px/)?.[1] ??
            '50000'
        )
  const configureViewport = (node: HTMLDivElement) => {
    if (node === outer && host !== 'worktree') {
      return
    }
    outer = node
    Object.defineProperties(outer, {
      clientHeight: { value: 300 },
      scrollHeight: { get: totalHeight },
      offsetHeight: { value: 300 },
      offsetWidth: { value: 1000 },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, totalHeight() - 300))
          cancelAnimationFrame(scrollFrame)
          scrollFrame = requestAnimationFrame(() => outer.dispatchEvent(new Event('scroll')))
        }
      }
    })
    added = vi.spyOn(outer, 'addEventListener')
    removed = vi.spyOn(outer, 'removeEventListener')
    outer.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 300)
    outer.getClientRects = () =>
      Object.assign([outer.getBoundingClientRect()], { item: () => outer.getBoundingClientRect() })
  }
  let deliverResize = () => {}
  if (host === 'worktree') {
    configureViewport(outer)
  } else {
    reviewHostFixture.configureViewport = configureViewport
    deliverResize = installReviewHostResizeObserver(() => outer)
  }

  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'wrapped content '.repeat(20)}`)
  const originalText = lines.join('\n')
  lines[10] = 'changed'
  reviewHostFixture.loadedContents = {
    originalContent: originalText,
    modifiedContent: lines.join('\n')
  }
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
      count: rowCount,
      overscan: 5,
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
      const disposeHeight = installDiffSectionHeightMeasurement(editor, setBodyHeight)
      editor.getModifiedEditor().onDidDispose(disposeHeight)
      disposers.push(disposeHeight)
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
  const Viewer = host === 'page' ? reviewHostComponents.page : reviewHostComponents.dialog
  const props = {
    files: Array.from({ length: rowCount }, (_, index) => ({
      path: `file-${String(index).padStart(3, '0')}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      isBinary: false
    })),
    comments: [],
    repoPath: '/repo',
    repoId: `reveal-${host}-${sideBySide}`,
    prNumber: 7,
    prUrl: 'https://example.test/pr/7',
    headSha: 'head',
    baseSha: 'base',
    pendingViewedPaths: new Set<string>(),
    onCommentAdded: () => {},
    onViewedChange: async () => true
  }
  const view = render(
    host === 'worktree' ? (
      <Rows />
    ) : (
      <TooltipProvider>
        <Viewer {...props} />
      </TooltipProvider>
    ),
    {
      container: host === 'worktree' ? outer : container
    }
  )
  if (host !== 'worktree') {
    await vi.waitFor(() =>
      expect(outer.querySelector('[data-index="2"] .monaco-diff-editor')).not.toBeNull()
    )
    if (sideBySide) {
      act(() => reviewHostFixture.toggleSplit?.())
    }
  }
  const header = outer.querySelector<HTMLElement>(
    '[data-index="2"] [data-combined-diff-section-header]'
  )!
  header.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 30)
  const original = monaco.editor.createModel(reviewHostFixture.loadedContents.originalContent)
  const modified = monaco.editor.createModel(reviewHostFixture.loadedContents.modifiedContent)
  disposers.push(() => {
    original.dispose()
    modified.dispose()
  })
  const editorTop = () =>
    host === 'worktree'
      ? 1030
      : Number.parseFloat(root.closest<HTMLElement>('[data-index]')?.style.top ?? '0') + 30
  const editorHeight = () =>
    host === 'worktree' ? height : Number.parseFloat(root.parentElement?.style.height ?? '500')
  for (const pane of [diff.getOriginalEditor(), diff.getModifiedEditor()]) {
    const host = pane.getContainerDomNode()
    host.getBoundingClientRect = () => new DOMRect(0, editorTop() - scrollTop, 500, editorHeight())
    host.getClientRects = () =>
      Object.assign([host.getBoundingClientRect()], { item: () => host.getBoundingClientRect() })
  }
  const root = diff.getContainerDomNode()
  root.getClientRects = () =>
    Object.assign([new DOMRect(0, editorTop() - scrollTop, 1000, editorHeight())], {
      item: () => null
    })
  diff.setModel({ original, modified })
  await vi.waitFor(() => expect(diff.getLineChanges()).not.toBeNull())
  disposers.push(() => cancelAnimationFrame(scrollFrame))
  for (let index = 0; index < 4; index++) {
    await act(async () => {
      deliverResize()
      await frame()
    })
  }
  return {
    outer,
    view,
    measuredHeight: () => (host === 'worktree' ? height : editorHeight() - 19),
    added,
    removed,
    settle: async () => {
      for (let index = 0; index < 4; index++) {
        await act(async () => {
          deliverResize()
          await frame()
        })
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

it.each([100, 1000])('bounds keyboard, extent and disposed work with %i rows', async (rowCount) => {
  const { outer, view, measuredHeight, settle, added, removed } = await fixture(true, rowCount)
  const pane = diff.getOriginalEditor()
  pane.focus()
  pane.setPosition({ lineNumber: 12, column: 1 })
  await settle()
  let keyboardEvents = 0
  const cursorEvents = pane.onDidChangeCursorPosition((event) => {
    if (event.source === 'keyboard') {
      keyboardEvents++
    }
  })
  disposers.push(() => cursorEvents.dispose())
  operations.bridge = 0
  for (let index = 0; index < 30; index++) {
    pane.trigger('keyboard', 'cursorDown', null)
  }
  expect(keyboardEvents).toBeGreaterThan(0)
  expect(keyboardEvents).toBeLessThanOrEqual(30)
  expect(operations.bridge).toBe(keyboardEvents)
  await act(frame)
  expect(operations.bridge).toBe(keyboardEvents + 1)
  await settle()
  expect(operations.bridge).toBe(keyboardEvents + 1)

  pane.setPosition({ lineNumber: 12, column: 1 })
  await settle()
  operations.bridge = 0
  const mounted = diff
  const disposed = vi.fn()
  pane.onDidDispose(disposed)
  await act(async () => {
    pane.trigger('keyboard', 'cursorBottom', null)
    outer.dispatchEvent(new Event('scroll'))
  })
  await settle()
  expect(disposed).not.toHaveBeenCalled()
  expect(diff).toBe(mounted)
  expect(operations.bridge).toBeGreaterThan(0)
  expect(operations.bridge).toBeLessThanOrEqual(5)
  const cursor = pane.getScrolledVisiblePosition(pane.getPosition()!)!
  const top = pane.getContainerDomNode().getBoundingClientRect().top + cursor.top
  expect(top).toBeGreaterThanOrEqual(30)
  expect(top + cursor.height).toBeLessThanOrEqual(300)

  notifyCombinedDiffDirectInput(outer)
  operations.bridge = 0
  operations.heightReads = 0
  operations.publications = 0
  const modifiedHeight = diff.getModifiedEditor().getContentHeight()
  act(() => {
    for (const bottom of [30_000, 35_000, 40_000]) {
      pane.updateOptions({ padding: { bottom } })
    }
  })
  expect(operations.publications).toBe(0)
  await act(frame)
  expect(operations.publications).toBe(1)
  expect(operations.heightReads).toBe(2)
  await settle()
  expect(operations.publications).toBe(1)
  expect(operations.bridge).toBe(0)
  expect(diff.getModifiedEditor().getContentHeight()).toBe(modifiedHeight)
  expect(measuredHeight()).toBe(pane.getContentHeight())
  expect(measuredHeight()).toBeGreaterThan(modifiedHeight)

  // Leave both installers with pending work, then dispose before their frames execute.
  act(() => {
    pane.trigger('keyboard', 'cursorTop', null)
    pane.updateOptions({ padding: { bottom: 45_000 } })
  })
  const beforeDispose = { ...operations }
  view.unmount()
  await settle()
  outer.dispatchEvent(new WheelEvent('wheel'))
  notifyCombinedDiffDirectInput(outer)
  expect(operations).toEqual(beforeDispose)
  const localListener = added.mock.calls.filter(
    ([type]) => type === COMBINED_DIFF_DIRECT_INPUT_EVENT
  )
  expect(localListener).toHaveLength(1)
  expect(removed).toHaveBeenCalledWith(COMBINED_DIFF_DIRECT_INPUT_EVENT, localListener[0][1])
  for (const type of ['pointerdown', 'wheel', 'touchmove']) {
    const listeners = added.mock.calls.filter(
      ([event, , options]) =>
        event === type && typeof options === 'object' && options.capture === true
    )
    expect(listeners).toHaveLength(1)
    for (const [event, listener] of listeners) {
      expect(removed).toHaveBeenCalledWith(event, listener, true)
    }
  }
})

it('yields pending and re-armed reveal to production scrollbar press and captured moves', async () => {
  const { outer, settle } = await fixture(true)
  const { result } = renderHook(() => {
    const scrollContainerRef = useRef(outer)
    const { markDirectScrollInput } = useCombinedDiffDirectScrollInput(scrollContainerRef)
    return useCombinedDiffScrollbar({ markDirectScrollInput, scrollContainerRef })
  })
  const trackView = render(
    <div data-testid="track" onPointerDown={result.current.handleScrollbarPointerDown} />
  )
  const track = trackView.getByTestId('track')
  track.getBoundingClientRect = () => new DOMRect(1000, 0, 16, 300)
  const captured = new Set<number>()
  track.setPointerCapture = (id) => {
    captured.add(id)
  }
  track.hasPointerCapture = (id) => captured.has(id)
  track.releasePointerCapture = (id) => {
    captured.delete(id)
  }
  const pane = diff.getModifiedEditor()
  pane.focus()
  pane.trigger('keyboard', 'cursorBottom', null)
  const focused = document.activeElement
  operations.bridge = 0
  fireEvent.pointerDown(track, { pointerId: 7, clientY: 40 })
  const pressed = outer.scrollTop
  expect(captured.has(7)).toBe(true)
  expect(document.activeElement).toBe(focused)
  diff.layout({ width: 999, height: pane.getContentHeight() })
  await settle()
  expect(outer.scrollTop).toBe(pressed)
  expect(operations.bridge).toBe(0)
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 2000, clientY: 20 })
  const moved = outer.scrollTop
  expect(moved).not.toBe(pressed)
  diff.layout({ width: 998, height: pane.getContentHeight() })
  await settle()
  expect(outer.scrollTop).toBe(moved)
  expect(operations.bridge).toBe(0)

  pane.trigger('keyboard', 'cursorTop', null)
  expect(operations.bridge).toBeGreaterThan(0)
  expect(captured.has(7)).toBe(true)
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 2000, clientY: 60 })
  const latest = outer.scrollTop
  operations.bridge = 0
  diff.layout({ width: 997, height: pane.getContentHeight() })
  await settle()
  expect(outer.scrollTop).toBe(latest)
  expect(operations.bridge).toBe(0)
  expect(document.activeElement).toBe(focused)
  fireEvent.pointerUp(window, { pointerId: 7 })
  expect(captured.size).toBe(0)
})

const reviewHosts = (['page', 'dialog'] as const).flatMap((host) => [
  { host, split: true, original: true },
  { host, split: true, original: false },
  { host, split: false, original: false }
])
it.each(reviewHosts)(
  'integrates $host visibility, retained tail and tree input (split=$split original=$original)',
  async ({ host, split, original }) => {
    const { outer, measuredHeight, settle } = await fixture(split, 100, host)
    expect(outer.hasAttribute('data-combined-diff-viewport')).toBe(true)
    expect(outer.classList.contains('scrollbar-editor')).toBe(true)
    expect(outer.classList.contains('combined-diff-scroll-container')).toBe(false)
    expect(
      diff
        .getContainerDomNode()
        .querySelector('.monaco-diff-editor')
        ?.classList.contains('side-by-side')
    ).toBe(split)
    const pane = original ? diff.getOriginalEditor() : diff.getModifiedEditor()
    const mounted = diff
    const disposed = vi.fn()
    pane.onDidDispose(disposed)
    const assertVisible = () => {
      const cursor = pane.getScrolledVisiblePosition(pane.getPosition()!)!
      const top = pane.getContainerDomNode().getBoundingClientRect().top + cursor.top
      expect(top).toBeGreaterThanOrEqual(30)
      expect(top + cursor.height).toBeLessThanOrEqual(300)
    }
    pane.focus()
    pane.setPosition({ lineNumber: 12, column: 1 })
    for (let index = 0; index < 30; index++) {
      pane.trigger('keyboard', 'cursorDown', null)
    }
    await settle()
    assertVisible()
    pane.setPosition({ lineNumber: 12, column: 1 })
    await settle()
    const extent = measuredHeight()
    const before = pane.getContentHeight()
    await act(async () => {
      pane.trigger('keyboard', 'cursorBottom', null)
      expect(measuredHeight()).toBe(extent)
      outer.dispatchEvent(new Event('scroll'))
    })
    expect(disposed).not.toHaveBeenCalled()
    await settle()
    expect(diff).toBe(mounted)
    expect(pane.getPosition()?.lineNumber).toBe(300)
    expect(pane.getContentHeight()).toBeGreaterThan(before)
    expect(reviewHostFixture.virtualizer?.getVirtualItems().some((item) => item.index === 2)).toBe(
      true
    )
    assertVisible()

    // Invoke the real semantic callback without synthesizing blur or a tree pointer event.
    pane.trigger('keyboard', 'cursorTop', null)
    const focused = document.activeElement
    operations.bridge = 0
    expect(reviewHostFixture.navigateTree).toBeDefined()
    act(() =>
      reviewHostFixture.navigateTree?.({
        path: 'file-000.ts',
        status: 'modified',
        added: 1,
        removed: 1
      })
    )
    const destination = outer.scrollTop
    expect(document.activeElement).toBe(focused)
    diff.layout({ width: 999, height: pane.getContentHeight() })
    await settle()
    expect(outer.scrollTop).toBe(destination)
    expect(operations.bridge).toBe(0)
    expect(disposed).not.toHaveBeenCalled()
  }
)
