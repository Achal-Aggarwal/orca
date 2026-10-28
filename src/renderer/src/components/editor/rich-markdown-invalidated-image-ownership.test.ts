// @vitest-environment happy-dom
import { Blob as NativeBlob } from 'node:buffer'
import { URL as NativeURL } from 'node:url'
import { Editor } from '@tiptap/core'
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
  invalidateLocalImageSrcCacheForTests,
  onImageCacheInvalidated,
  resetLocalImageSrcStateForTests
} from './useLocalImageSrc'

const IMAGE_BYTES = 4 * 1024 * 1024
const imageBase64 = Buffer.alloc(IMAGE_BYTES).toString('base64')
const createNativeUrl = NativeURL.createObjectURL.bind(NativeURL)
const revokeNativeUrl = NativeURL.revokeObjectURL.bind(NativeURL)
const liveUrls = new Map<string, number>()
const editors: Editor[] = []
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
  return {
    editor,
    image,
    close: () => {
      editor.destroy()
      host.remove()
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

  it('preserves the 30-second hard fallback when a displayed replacement never arrives', async () => {
    const document = await mountDocument()
    const previous = document.image.src
    holdReads = true
    invalidateLocalImageSrcCacheForTests()
    await flushImages()
    vi.advanceTimersByTime(29_999)
    expect(liveUrls.has(previous)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(liveUrls.has(previous)).toBe(false)
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
