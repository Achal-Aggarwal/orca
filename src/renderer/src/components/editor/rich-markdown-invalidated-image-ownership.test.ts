// @vitest-environment happy-dom
import { Blob as NativeBlob } from 'node:buffer'
import { URL as NativeURL } from 'node:url'
import { Editor } from '@tiptap/core'
import { act, createElement, StrictMode, Suspense, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { acquireLocalImageDisplayLease } from './local-image-display-lease'
import { documentResourceAccess } from '@/lib/local-file-access'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  blobUrlCache,
  cacheLocalImageBlob,
  pinLocalImageCache,
  unpinLocalImageCache
} from './local-image-src-cache'
import {
  acquireLocalImageSrcLease,
  getLocalImageSrcCacheKey,
  invalidateLocalImageSrcCacheForTests,
  onImageCacheInvalidated,
  releaseLocalImageSrcByKey,
  resetLocalImageSrcStateForTests,
  useLocalImageSrc
} from './useLocalImageSrc'

const IMAGE_BYTES = 4 * 1024 * 1024
const imageBase64 = Buffer.alloc(IMAGE_BYTES).toString('base64')
const createNativeUrl = NativeURL.createObjectURL.bind(NativeURL)
const revokeNativeUrl = NativeURL.revokeObjectURL.bind(NativeURL)
const liveUrls = new Map<string, number>()
const editors: Editor[] = []
const hookRoots = new Set<Root>()
const pendingReads: ((value: PreviewResult) => void)[] = []
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
let holdReads = false

type PreviewResult = Awaited<ReturnType<Window['api']['fs']['readFile']>>
const imageResult: PreviewResult = { content: imageBase64, isBinary: true, mimeType: 'image/png' }
const readFile = vi.fn(() =>
  holdReads
    ? new Promise<PreviewResult>((resolve) => pendingReads.push(resolve))
    : Promise.resolve(imageResult)
)

async function flushImages(): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve()
  }
}

async function mountDocument() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: '![](image.png)',
    contentType: 'markdown'
  })
  editors.push(editor)
  setRichMarkdownImageResolverContext(editor, { filePath: '/repo/docs/readme.md' })
  await flushImages()
  const image = host.querySelector('img')
  if (!image?.src.startsWith('blob:')) {
    throw new Error('The mounted image did not receive a Blob URL')
  }
  image.dispatchEvent(new Event('load'))
  return {
    editor,
    image,
    close: () => {
      editor.destroy()
      host.remove()
    }
  }
}

function GenericImage(): React.JSX.Element {
  return createElement('img', {
    src: useLocalImageSrc(
      'image.png',
      '/repo/docs/readme.md',
      undefined,
      undefined,
      documentResourceAccess('/repo/docs/readme.md')
    )
  })
}

async function mountGenericImage() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  hookRoots.add(root)
  await act(async () => {
    root.render(createElement(GenericImage))
    await flushImages()
  })
  const image = host.querySelector('img')
  if (!image?.src.startsWith('blob:')) {
    throw new Error('The generic hook did not receive a Blob URL')
  }
  return {
    image,
    close: () => {
      act(() => root.unmount())
      hookRoots.delete(root)
      host.remove()
    }
  }
}

async function mountScheduledGenericImage() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  hookRoots.add(root)
  let source = 'image.png'
  let blocked = false
  let committed: string | undefined
  let pending: string | undefined
  let resume: (() => void) | undefined
  const blocker = new Promise<void>((resolve) => {
    resume = resolve
  })
  const validCommits: boolean[] = []
  function ScheduledImage() {
    const resolved = useLocalImageSrc(source, '/repo/docs/readme.md')
    useLayoutEffect(() => {
      committed = resolved
      validCommits.push(!resolved || liveUrls.has(resolved) || !resolved.startsWith('blob:'))
    }, [resolved])
    if (blocked && resolved && resolved !== committed) {
      pending = resolved
      throw blocker
    }
    return createElement('img', { src: resolved })
  }
  const render = () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(Suspense, { fallback: 'Delayed image commit' }, createElement(ScheduledImage))
      )
    )
  await act(async () => {
    render()
    await flushImages()
  })
  return {
    host,
    validCommits,
    get committed() {
      return committed
    },
    get pending() {
      return pending
    },
    block: () => {
      blocked = true
    },
    source: async (next: string) => {
      source = next
      await act(async () => {
        render()
        await flushImages()
      })
    },
    resume: async () => {
      blocked = false
      await act(async () => {
        resume?.()
        await flushImages()
      })
    }
  }
}

function retiredBlobBytes(): number {
  const cached = new Set(blobUrlCache.values())
  let bytes = 0
  for (const [url, byteLength] of liveUrls) {
    if (!cached.has(url)) {
      bytes += byteLength
    }
  }
  return bytes
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.useFakeTimers()
  vi.stubGlobal('Blob', NativeBlob)
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    if (!(blob instanceof NativeBlob)) {
      throw new Error('The workload must allocate native Blobs')
    }
    const url = createNativeUrl(blob)
    liveUrls.set(url, blob.size)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    liveUrls.delete(url)
    revokeNativeUrl(url)
  })
  resetLocalImageSrcStateForTests()
  readFile.mockClear()
  holdReads = false
  Object.defineProperty(window, 'api', { value: { fs: { readFile } }, configurable: true })
})

afterEach(async () => {
  act(() => {
    for (const root of hookRoots) {
      root.unmount()
    }
  })
  hookRoots.clear()
  for (const editor of editors.splice(0)) {
    if (!editor.isDestroyed) {
      editor.destroy()
    }
  }
  for (const resolve of pendingReads.splice(0)) {
    resolve({ content: '', isBinary: false })
  }
  await flushImages()
  resetLocalImageSrcStateForTests()
  for (const url of liveUrls.keys()) {
    revokeNativeUrl(url)
  }
  liveUrls.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
  document.body.innerHTML = ''
})

describe('invalidated rich image display ownership', () => {
  it.each([3, 10])(
    'releases replaced generations after %i refreshes while the document stays open',
    async (cycles) => {
      const view = await mountDocument()
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const previous = view.image.src
        invalidateLocalImageSrcCacheForTests()
        await flushImages()
        expect(view.image.src).not.toBe(previous)
        view.image.dispatchEvent(new Event('load'))
        await flushImages()
        expect(retiredBlobBytes()).toBe(0)
        expect(liveUrls.size).toBe(1)
      }
    }
  )

  it.each([3, 10])(
    'releases retired image generations after %i real document closes',
    async (cycles) => {
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const view = await mountDocument()
        const previous = view.image.src
        invalidateLocalImageSrcCacheForTests()
        await flushImages()
        expect(view.image.src).not.toBe(previous)
        expect(document.body.querySelector(`img[src="${previous}"]`)).toBeNull()
        view.close()
        await flushImages()
        expect(document.body.querySelector('img')).toBeNull()
      }
      const retainedRetiredBytes = retiredBlobBytes()
      console.info(
        'CLOSED_INVALIDATED_IMAGE_BYTES',
        JSON.stringify({ cycles, retainedRetiredBytes })
      )
      expect(retainedRetiredBytes).toBe(0)
    }
  )

  it('preserves a still-displayed old URL across the synchronous reload handoff', async () => {
    const document = await mountDocument()
    const previous = document.image.src
    holdReads = true
    invalidateLocalImageSrcCacheForTests()
    await flushImages()
    expect(document.image.src).toBe(previous)
    expect(liveUrls.has(previous)).toBe(true)
    expect(pendingReads).toHaveLength(1)
    pendingReads.shift()?.(imageResult)
    await flushImages()
    expect(document.image.src).not.toBe(previous)
    expect(liveUrls.has(previous)).toBe(true)
    const replacement = document.image.src
    invalidateLocalImageSrcCacheForTests()
    await flushImages()
    expect(document.image.src).toBe(replacement)
    expect(liveUrls.has(previous)).toBe(true)
    expect(liveUrls.has(replacement)).toBe(true)
    document.close()
    await flushImages()
    expect(liveUrls.has(previous)).toBe(false)
    expect(liveUrls.has(replacement)).toBe(false)
  })

  it('retains an old URL for a surviving shared display and releases it after the final close', async () => {
    const first = await mountDocument()
    const second = await mountDocument()
    const previous = first.image.src
    expect(second.image.src).toBe(previous)
    holdReads = true
    invalidateLocalImageSrcCacheForTests()
    await flushImages()
    first.close()
    await flushImages()
    expect(second.image.src).toBe(previous)
    expect(liveUrls.has(previous)).toBe(true)
    second.close()
    await flushImages()
    expect(liveUrls.has(previous)).toBe(false)
  })

  it('preserves a known displayed generation beyond 30 seconds when its replacement is still reading', async () => {
    const document = await mountDocument()
    const previous = document.image.src
    holdReads = true
    invalidateLocalImageSrcCacheForTests()
    await flushImages()
    vi.advanceTimersByTime(29_999)
    expect(liveUrls.has(previous)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(liveUrls.has(previous)).toBe(true)
    document.close()
    await flushImages()
    expect(liveUrls.has(previous)).toBe(false)
  })

  it('keeps the old generation until every shared display finishes its replacement', async () => {
    const first = await mountDocument()
    const second = await mountDocument()
    const previous = first.image.src
    invalidateLocalImageSrcCacheForTests()
    await flushImages()
    first.image.dispatchEvent(new Event('load'))
    await flushImages()
    expect(liveUrls.has(previous)).toBe(true)
    second.image.dispatchEvent(new Event('load'))
    await flushImages()
    expect(liveUrls.has(previous)).toBe(false)
    expect(liveUrls.size).toBe(1)
  })

  it('releases the previous generation when replacement decoding fails', async () => {
    const view = await mountDocument()
    const previous = view.image.src
    invalidateLocalImageSrcCacheForTests()
    await flushImages()
    view.image.dispatchEvent(new Event('error'))
    await flushImages()
    expect(liveUrls.has(previous)).toBe(false)
    expect(liveUrls.size).toBe(1)
  })

  it('keeps the 30-second fallback for legacy key-only leases', async () => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(IMAGE_BYTES)]))
    expect(cacheLocalImageBlob('legacy-owner', url, IMAGE_BYTES)).toBe(true)
    pinLocalImageCache('legacy-owner')
    invalidateLocalImageSrcCacheForTests()
    await flushImages()
    vi.advanceTimersByTime(29_999)
    await flushImages()
    expect(liveUrls.has(url)).toBe(true)
    vi.advanceTimersByTime(1)
    await flushImages()
    expect(liveUrls.has(url)).toBe(false)
    unpinLocalImageCache('legacy-owner')
  })

  it('releases generic-hook generations after each committed replacement', async () => {
    const view = await mountGenericImage()
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const previous = view.image.src
      await act(async () => {
        invalidateLocalImageSrcCacheForTests()
        await flushImages()
      })
      expect(view.image.src).not.toBe(previous)
      expect(liveUrls.has(previous)).toBe(false)
      expect(liveUrls.size).toBe(1)
    }
  })

  it('retains a generic source before a suspended commit when its cache entry is overwritten', async () => {
    const view = await mountScheduledGenericImage()
    const previous = view.committed
    expect(previous).toBeTruthy()
    view.block()
    await act(async () => {
      invalidateLocalImageSrcCacheForTests()
      await flushImages()
    })
    const pending = view.pending
    expect(pending).toBeTruthy()
    const key = getLocalImageSrcCacheKey('image.png', '/repo/docs/readme.md')
    expect(key).toBeTruthy()
    if (!key || !pending || !previous) {
      throw new Error('Missing scheduled image source')
    }
    const replacement = URL.createObjectURL(new Blob([new Uint8Array(1)]))
    expect(cacheLocalImageBlob(key, replacement, 1)).toBe(true)
    await flushImages()
    expect(liveUrls.has(previous)).toBe(true)
    expect(liveUrls.has(pending)).toBe(true)
    await view.resume()
    expect(view.validCommits.every(Boolean)).toBe(true)
    expect(liveUrls.has(previous)).toBe(false)
  })

  it.each(['next.png', 'https://example.test/image.png'])(
    'retains the committed generic URL while changing to %s under cache pressure',
    async (source) => {
      const view = await mountScheduledGenericImage()
      const previous = view.committed
      const oldKey = getLocalImageSrcCacheKey('image.png', '/repo/docs/readme.md')
      if (!oldKey || !previous) {
        throw new Error('Missing committed image')
      }
      for (let index = 0; index < 100; index += 1) {
        const key = `pressure-${index}`
        pinLocalImageCache(key, 'display')
        const url = URL.createObjectURL(new Blob([new Uint8Array(1)]))
        expect(cacheLocalImageBlob(key, url, 1)).toBe(true)
      }
      view.block()
      await view.source(source)
      await flushImages()
      expect(view.pending).toBeTruthy()
      expect(blobUrlCache.has(oldKey)).toBe(false)
      expect(liveUrls.has(previous)).toBe(true)
      await view.resume()
      expect(view.validCommits.every(Boolean)).toBe(true)
      expect(liveUrls.has(previous)).toBe(false)
    }
  )

  it.each(['invalidate', 'prune'])(
    'protects an initially cached source before ancestor layout effects %s it',
    async (action) => {
      const filePath = '/repo/docs/readme.md'
      const key = getLocalImageSrcCacheKey('image.png', filePath)
      if (!key) {
        throw new Error('Missing cached image key')
      }
      const cached = URL.createObjectURL(new Blob([new Uint8Array(IMAGE_BYTES)]))
      expect(cacheLocalImageBlob(key, cached, IMAGE_BYTES)).toBe(true)
      const validCommits: boolean[] = []
      function Image() {
        const source = useLocalImageSrc('image.png', filePath)
        useLayoutEffect(() => {
          validCommits.push(!source || liveUrls.has(source))
        }, [source])
        return createElement('img', { src: source })
      }
      function Parent() {
        useLayoutEffect(() => {
          if (action === 'invalidate') {
            invalidateLocalImageSrcCacheForTests()
          } else {
            releaseLocalImageSrcByKey(key)
          }
          expect(liveUrls.has(cached)).toBe(true)
        }, [])
        return createElement(Image)
      }
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      hookRoots.add(root)
      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(Parent)))
        await flushImages()
      })
      expect(validCommits.every(Boolean)).toBe(true)
      expect(host.querySelector('img')?.src.startsWith('blob:')).toBe(true)
    }
  )

  it('releases a bootstrapped display lease when an ancestor layout effect immediately unmounts it', async () => {
    const key = getLocalImageSrcCacheKey('image.png', '/repo/docs/readme.md')
    if (!key) {
      throw new Error('Missing cached image key')
    }
    const cached = URL.createObjectURL(new Blob([new Uint8Array(1)]))
    expect(cacheLocalImageBlob(key, cached, 1)).toBe(true)
    function Image() {
      return createElement('img', { src: useLocalImageSrc('image.png', '/repo/docs/readme.md') })
    }
    function Parent() {
      const [show, setShow] = useState(true)
      useLayoutEffect(() => setShow(false), [])
      return show ? createElement(Image) : null
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    hookRoots.add(root)
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Parent)))
      await flushImages()
    })
    expect(host.querySelector('img')).toBeNull()
    invalidateLocalImageSrcCacheForTests()
    await flushImages()
    expect(liveUrls.size).toBe(0)
  })

  it('preserves the rich display while a shared generic hook adopts the new generation', async () => {
    const rich = await mountDocument()
    const generic = await mountGenericImage()
    const previous = rich.image.src
    expect(generic.image.src).toBe(previous)
    await act(async () => {
      invalidateLocalImageSrcCacheForTests()
      await flushImages()
    })
    expect(generic.image.src).toBe(rich.image.src)
    expect(generic.image.src).not.toBe(previous)
    expect(liveUrls.has(previous)).toBe(true)
    rich.image.dispatchEvent(new Event('load'))
    await flushImages()
    expect(liveUrls.has(previous)).toBe(false)
    expect(liveUrls.size).toBe(1)
  })

  it('releases generic-hook generations on close during a replacement read', async () => {
    const view = await mountGenericImage()
    const previous = view.image.src
    holdReads = true
    await act(async () => {
      invalidateLocalImageSrcCacheForTests()
      await flushImages()
    })
    expect(liveUrls.has(previous)).toBe(true)
    view.close()
    await flushImages()
    expect(liveUrls.has(previous)).toBe(false)
    pendingReads.shift()?.(imageResult)
    await flushImages()
    expect(liveUrls.size).toBe(0)
    expect(blobUrlCache.size).toBe(0)
  })

  it('keeps a legacy caller safe when a tracked display adopts its replacement', async () => {
    const view = await mountDocument()
    const release = acquireLocalImageSrcLease(
      'image.png',
      '/repo/docs/readme.md',
      undefined,
      undefined,
      documentResourceAccess('/repo/docs/readme.md')
    )
    const previous = view.image.src
    invalidateLocalImageSrcCacheForTests()
    await flushImages()
    view.image.dispatchEvent(new Event('load'))
    await flushImages()
    expect(liveUrls.has(previous)).toBe(true)
    release?.()
    await flushImages()
    expect(liveUrls.has(previous)).toBe(false)
  })

  it('releases abandoned replacements while retaining the last decoded generation', async () => {
    const view = await mountDocument()
    const decoded = view.image.src
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const previous = view.image.src
      invalidateLocalImageSrcCacheForTests()
      await flushImages()
      expect(view.image.src).not.toBe(previous)
      expect(liveUrls.has(decoded)).toBe(true)
      if (previous !== decoded) {
        expect(liveUrls.has(previous)).toBe(false)
      }
      expect(liveUrls.size).toBe(2)
    }
    view.image.dispatchEvent(new Event('load'))
    await flushImages()
    expect(liveUrls.has(decoded)).toBe(false)
    expect(liveUrls.size).toBe(1)
  })

  it('releases an old URL when an invalidation listener closes its last display', async () => {
    const view = await mountDocument()
    const previous = view.image.src
    const unsubscribe = onImageCacheInvalidated(() => view.close())
    try {
      invalidateLocalImageSrcCacheForTests()
      await flushImages()
      expect(document.body.querySelector('img')).toBeNull()
      expect(liveUrls.has(previous)).toBe(false)
    } finally {
      unsubscribe()
    }
  })

  it('does not let a stale display lease unpin a new display after reset', async () => {
    const previous = acquireLocalImageDisplayLease('same-owner')
    resetLocalImageSrcStateForTests()
    const current = acquireLocalImageDisplayLease('same-owner')
    const url = URL.createObjectURL(new Blob([new Uint8Array(IMAGE_BYTES)]))
    expect(cacheLocalImageBlob('same-owner', url, IMAGE_BYTES)).toBe(true)
    current.setDisplayedUrls([url])
    previous.release()
    releaseLocalImageSrcByKey('same-owner')
    expect(blobUrlCache.get('same-owner')).toBe(url)
    expect(liveUrls.has(url)).toBe(true)
    current.release()
    releaseLocalImageSrcByKey('same-owner')
    await flushImages()
    expect(liveUrls.has(url)).toBe(false)
  })

  it('does not let pending cleanup from a reset remove a new retired group for the same key', async () => {
    const cacheRetiredImage = () => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(IMAGE_BYTES)]))
      expect(cacheLocalImageBlob('same-owner', url, IMAGE_BYTES)).toBe(true)
      pinLocalImageCache('same-owner')
      invalidateLocalImageSrcCacheForTests()
      unpinLocalImageCache('same-owner')
      return url
    }
    const previous = cacheRetiredImage()
    resetLocalImageSrcStateForTests()
    const replacement = cacheRetiredImage()
    await flushImages()
    expect(liveUrls.has(previous)).toBe(false)
    expect(liveUrls.has(replacement)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
