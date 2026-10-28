// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollTopCache } from '@/lib/scroll-cache'
import { useIpynbScrollRestoration } from './useIpynbScrollRestoration'

function NotebookScrollSurface({
  ready,
  cacheKey = 'notebook',
  revision = 0
}: {
  ready: boolean
  cacheKey?: string
  revision?: number
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useIpynbScrollRestoration(rootRef, cacheKey, ready)
  return ready ? <div ref={rootRef} data-testid="notebook" data-revision={revision} /> : null
}

beforeEach(() => {
  vi.useFakeTimers()
  scrollTopCache.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  scrollTopCache.clear()
})

describe('notebook scroll restoration', () => {
  it('remembers scroll when invalid source becomes a notebook without remounting the viewer', () => {
    const view = render(<NotebookScrollSurface ready={false} />)
    view.rerender(<NotebookScrollSurface ready />)
    const notebook = screen.getByTestId('notebook')
    notebook.scrollTop = 500
    fireEvent.scroll(notebook)
    vi.advanceTimersByTime(150)
    expect(scrollTopCache.get('notebook')).toBe(500)

    view.unmount()
    render(<NotebookScrollSurface ready />)
    expect(screen.getByTestId('notebook').scrollTop).toBe(500)
  })

  it('keeps the latest position while source changes before the scroll debounce flushes', () => {
    scrollTopCache.set('notebook', 200)
    const view = render(<NotebookScrollSurface ready />)
    const notebook = screen.getByTestId('notebook')
    expect(notebook.scrollTop).toBe(200)
    notebook.scrollTop = 500
    fireEvent.scroll(notebook)
    view.rerender(<NotebookScrollSurface ready revision={1} />)
    expect(notebook.scrollTop).toBe(500)
    vi.advanceTimersByTime(150)
    expect(scrollTopCache.get('notebook')).toBe(500)
  })

  it('flushes and detaches an invalidated root, then restores and tracks its replacement', () => {
    const view = render(<NotebookScrollSurface ready />)
    const previous = screen.getByTestId('notebook')
    previous.scrollTop = 410
    fireEvent.scroll(previous)
    view.rerender(<NotebookScrollSurface ready={false} />)
    expect(scrollTopCache.get('notebook')).toBe(410)

    previous.scrollTop = 990
    fireEvent.scroll(previous)
    vi.runAllTimers()
    expect(scrollTopCache.get('notebook')).toBe(410)

    view.rerender(<NotebookScrollSurface ready />)
    const replacement = screen.getByTestId('notebook')
    expect(replacement).not.toBe(previous)
    expect(replacement.scrollTop).toBe(410)
    replacement.scrollTop = 450
    fireEvent.scroll(replacement)
    vi.advanceTimersByTime(150)
    expect(scrollTopCache.get('notebook')).toBe(450)
  })

  it('flushes the previous owner before restoring a different notebook in the same root', () => {
    scrollTopCache.set('notebook', 100)
    scrollTopCache.set('other-notebook', 800)
    const view = render(<NotebookScrollSurface ready />)
    const notebook = screen.getByTestId('notebook')
    notebook.scrollTop = 350
    fireEvent.scroll(notebook)
    view.rerender(<NotebookScrollSurface ready cacheKey="other-notebook" />)
    expect(scrollTopCache.get('notebook')).toBe(350)
    expect(notebook.scrollTop).toBe(800)
    notebook.scrollTop = 900
    fireEvent.scroll(notebook)
    vi.advanceTimersByTime(150)
    expect(scrollTopCache.get('other-notebook')).toBe(900)
    expect(scrollTopCache.get('notebook')).toBe(350)
  })
})
