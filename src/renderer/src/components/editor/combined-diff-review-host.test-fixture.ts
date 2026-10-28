import React from 'react'
import { vi } from 'vitest'
import type { Virtualizer } from '@tanstack/react-virtual'
import type * as VirtualBindings from '@tanstack/react-virtual'
import type { DiffSection } from './diff-section-types'
import type { CombinedDiffFileTreeEntry } from './combined-diff/resolve-changes/combined-diff-section-identity'
import { PRFilesCombinedDiffViewer as PageViewer } from '../pull-request-page/files/combined-diff-viewer'
import { PRFilesCombinedDiffViewer as DialogViewer } from '../github-item-dialog/inspect-pull-request/pr-files-combined-diff-viewer'

export const reviewHostFixture: {
  configureViewport?: (node: HTMLDivElement) => void
  virtualizer?: Virtualizer<HTMLDivElement, Element>
  navigateTree?: (entry: CombinedDiffFileTreeEntry) => void
  toggleSplit?: () => void
  loadedContents: { originalContent: string; modifiedContent: string }
} = { loadedContents: { originalContent: '', modifiedContent: '' } }
export const reviewHostComponents = { page: PageViewer, dialog: DialogViewer }

const loadTarget = (
  index: number,
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
) => {
  if (index === 2) {
    setSections((prev) =>
      prev[2]?.loading
        ? prev.map((section, row) =>
            row === 2
              ? { ...section, ...reviewHostFixture.loadedContents, loading: false }
              : section
          )
        : prev
    )
  }
}
vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof VirtualBindings>()
  return {
    ...actual,
    useVirtualizer: (
      options: Parameters<typeof actual.useVirtualizer<HTMLDivElement, Element>>[0]
    ) => {
      const instance = actual.useVirtualizer(
        reviewHostFixture.configureViewport
          ? {
              ...options,
              initialRect: { width: 1000, height: 300 },
              getScrollElement: () => {
                const node = options.getScrollElement()
                if (node) {
                  reviewHostFixture.configureViewport?.(node)
                }
                return node
              }
            }
          : options
      )
      if (reviewHostFixture.configureViewport) {
        reviewHostFixture.virtualizer = instance
      }
      return instance
    }
  }
})
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: { theme: 'dark', diffWordWrap: true },
      editorFontZoomLevel: 0,
      worktreesByRepo: {},
      runtimeEnvironments: [],
      folderWorkspaces: []
    })
}))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
vi.mock('@/lib/monaco-setup', async () => ({
  monaco: await import('monaco-editor/esm/vs/editor/editor.api.js')
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({ useDiffCommentDecorator: () => {} }))
vi.mock('./combined-diff/browse-files/combined-diff-file-tree', () => ({
  CombinedDiffFileTree: ({ onNavigate }: { onNavigate: typeof reviewHostFixture.navigateTree }) => {
    reviewHostFixture.navigateTree = onNavigate
    return null
  }
}))
vi.mock('../pull-request-page/files/toolbar', () => ({
  PRFilesDiffToolbar: ({ onToggleSideBySide }: { onToggleSideBySide: () => void }) => {
    reviewHostFixture.toggleSplit = onToggleSideBySide
    return null
  }
}))
vi.mock('../github-item-dialog/inspect-pull-request/pr-files-combined-diff-toolbar', () => ({
  PRFilesCombinedDiffToolbar: ({ onToggleSideBySide }: { onToggleSideBySide: () => void }) => {
    reviewHostFixture.toggleSplit = onToggleSideBySide
    return null
  }
}))
vi.mock('../pull-request-page/files/section-loader', () => ({
  usePRFileSectionLoader: ({
    setSections
  }: {
    setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  }) => ({
    loadSection: React.useCallback(
      (index: number) => loadTarget(index, setSections),
      [setSections]
    ),
    retrySection: () => {},
    toggleSection: () => {},
    setAllSectionsCollapsed: () => {}
  })
}))
vi.mock('../github-item-dialog/inspect-pull-request/pr-files-combined-diff-load', () => ({
  loadPRFilesCombinedDiffSection: ({
    index,
    setSections
  }: {
    index: number
    setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  }) => loadTarget(index, setSections),
  retryPRFilesCombinedDiffSection: () => {},
  togglePRFilesCombinedDiffSection: () => {},
  setAllPRFilesCombinedDiffSectionsCollapsed: () => {},
  addPRFilesCombinedDiffLineComment: () => Promise.resolve(false)
}))

// Supply browser layout only; host range extraction and row measurement stay real.
export function installReviewHostResizeObserver(getViewport: () => HTMLElement): () => void {
  const resizeObservers = new Set<() => void>()
  const nodeHeight = (node: Element): number =>
    node === getViewport()
      ? 300
      : node instanceof HTMLElement
        ? Number.parseFloat(node.querySelector<HTMLElement>('.relative')?.style.height || '60') + 28
        : 88
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private nodes = new Map<Element, number>()
      constructor(private callback: ResizeObserverCallback) {
        resizeObservers.add(this.deliver)
      }
      observe(node: Element) {
        if (node !== getViewport()) {
          Object.defineProperty(node, 'offsetHeight', {
            configurable: true,
            get: () => nodeHeight(node)
          })
        }
        this.nodes.set(node, -1)
      }
      unobserve(node: Element) {
        this.nodes.delete(node)
      }
      disconnect() {
        this.nodes.clear()
        resizeObservers.delete(this.deliver)
      }
      deliver = () => {
        const entries: ResizeObserverEntry[] = []
        for (const [node, previous] of this.nodes) {
          const size = nodeHeight(node)
          if (previous === size) {
            continue
          }
          this.nodes.set(node, size)
          const box = [{ inlineSize: 1000, blockSize: size }]
          entries.push({
            target: node,
            contentRect: new DOMRect(0, 0, 1000, size),
            borderBoxSize: box,
            contentBoxSize: box,
            devicePixelContentBoxSize: box
          })
        }
        if (entries.length) {
          this.callback(entries, this)
        }
      }
    }
  )
  return () => resizeObservers.forEach((deliver) => deliver())
}
