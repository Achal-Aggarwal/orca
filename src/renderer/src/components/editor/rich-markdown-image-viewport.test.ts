import { ImageVisibilityObserver } from './document-image-visibility.test-fixture'
// @vitest-environment happy-dom
import { Blob as NativeBlob } from 'node:buffer'
import { URL as NativeURL } from 'node:url'
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'
import { resetLocalImageSrcStateForTests } from './useLocalImageSrc'

type FileResult = Awaited<ReturnType<Window['api']['fs']['readFile']>>
const readFile = vi.fn<Window['api']['fs']['readFile']>()
const imageResult: FileResult = { content: 'AA==', isBinary: true, mimeType: 'image/png' }
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const editors: Editor[] = []

async function settle(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    await Promise.resolve()
  }
}

function mountImages(count: number, repeated = false) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: Array.from(
      { length: count },
      (_, i) => `![Image ${i}](image-${repeated ? 0 : i}.png)`
    ).join('\n\n'),
    contentType: 'markdown'
  })
  editors.push(editor)
  setRichMarkdownImageResolverContext(editor, { filePath: '/folder/docs/readme.md' })
  return { editor, images: Array.from(host.querySelectorAll('img')) }
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  vi.stubGlobal('IntersectionObserver', ImageVisibilityObserver)
  readFile.mockReset().mockResolvedValue(imageResult)
  Object.defineProperty(window, 'api', { configurable: true, value: { fs: { readFile } } })
  let urls = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:image-${urls++}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  resetLocalImageSrcStateForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
  document.body.innerHTML = ''
})

it.each([100, 1000])(
  'admits only visible owners from %i mounted images and disconnects on close',
  async (count) => {
    const { editor, images } = mountImages(count)
    expect(images).toHaveLength(count)
    await settle()
    expect(readFile).not.toHaveBeenCalled()
    for (const image of images.slice(0, 3)) {
      ImageVisibilityObserver.current.emit(image, true)
    }
    await settle()
    expect(readFile).toHaveBeenCalledTimes(3)
    expect(images.filter((image) => image.hasAttribute('src'))).toHaveLength(3)
    editor.destroy()
    expect(ImageVisibilityObserver.current.targets.size).toBe(0)
    expect(ImageVisibilityObserver.current.disconnect).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3)
  }
)

it('recovers a refused visible image after capacity frees and can revisit a document larger than the byte budget', async () => {
  const byteLength = 4 * 1024 * 1024
  readFile.mockResolvedValue({
    ...imageResult,
    content: Buffer.alloc(byteLength).toString('base64')
  })
  const live = new Map<string, number>()
  const create = NativeURL.createObjectURL.bind(NativeURL)
  const revoke = NativeURL.revokeObjectURL.bind(NativeURL)
  vi.stubGlobal('Blob', NativeBlob)
  vi.mocked(URL.createObjectURL).mockImplementation((blob) => {
    if (!(blob instanceof NativeBlob)) {
      throw new Error('Expected a native Blob')
    }
    const url = create(blob)
    live.set(url, blob.size)
    return url
  })
  vi.mocked(URL.revokeObjectURL).mockImplementation((url) => {
    live.delete(url)
    revoke(url)
  })
  const { editor, images } = mountImages(33)
  for (const image of images) {
    ImageVisibilityObserver.current.emit(image, true)
  }
  await settle()
  expect(readFile).toHaveBeenCalledTimes(33)
  expect(images.filter((image) => image.hasAttribute('src'))).toHaveLength(32)
  expect([...live.values()].reduce((sum, bytes) => sum + bytes, 0)).toBe(128 * 1024 * 1024)
  const blocked = images.find((image) => !image.hasAttribute('src'))
  const first = images.find((image) => image.hasAttribute('src'))
  if (!blocked || !first) {
    throw new Error('Budget overload was not reached')
  }
  ImageVisibilityObserver.current.emit(first, false)
  await settle()
  expect(blocked.hasAttribute('src')).toBe(true)
  expect(first.hasAttribute('src')).toBe(false)
  expect(readFile).toHaveBeenCalledTimes(34)
  for (const image of images) {
    ImageVisibilityObserver.current.emit(image, false)
  }
  expect(live.size).toBe(0)
  for (const image of images) {
    ImageVisibilityObserver.current.emit(image, true)
    await settle()
    expect(image.hasAttribute('src')).toBe(true)
    expect(live.size).toBe(1)
    ImageVisibilityObserver.current.emit(image, false)
  }
  editor.destroy()
  expect(live.size).toBe(0)
})

it('drops offscreen queued reads while allowing an active native read to settle', async () => {
  const pending = Promise.withResolvers<FileResult>()
  readFile.mockReturnValue(pending.promise)
  const { images } = mountImages(10)
  for (const image of images) {
    ImageVisibilityObserver.current.emit(image, true)
  }
  await settle()
  expect(readFile).toHaveBeenCalledTimes(4)
  for (const image of images) {
    ImageVisibilityObserver.current.emit(image, false)
  }
  pending.resolve(imageResult)
  await settle()
  expect(readFile).toHaveBeenCalledTimes(4)
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  const last = images.at(-1)
  if (!last) {
    throw new Error('Last image missing')
  }
  ImageVisibilityObserver.current.emit(last, true)
  await settle()
  expect(readFile).toHaveBeenCalledTimes(5)
  expect(last.hasAttribute('src')).toBe(true)
})

it('preserves a shared display and revalidates only visible owners', async () => {
  const { images } = mountImages(2, true)
  const first = images[0]
  const second = images[1]
  if (!first || !second) {
    throw new Error('Shared images missing')
  }
  ImageVisibilityObserver.current.emit(first, true)
  ImageVisibilityObserver.current.emit(second, true)
  await settle()
  expect(readFile).toHaveBeenCalledTimes(1)
  const shared = second.src
  ImageVisibilityObserver.current.emit(first, false)
  expect(second.src).toBe(shared)
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(shared)
  window.dispatchEvent(new Event('focus'))
  await settle()
  expect(readFile).toHaveBeenCalledTimes(2)
  expect(first.hasAttribute('src')).toBe(false)
  expect(second.src).not.toBe(shared)
  ImageVisibilityObserver.current.emit(second, false)
  await settle()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(shared)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-1')
})

it('keeps authored dimensions current while offscreen and releases its placeholder after load', async () => {
  const { editor, images } = mountImages(1)
  const image = images[0]
  if (!image) {
    throw new Error('Image missing')
  }
  const node = editor.state.doc.nodeAt(1)
  if (!node) {
    throw new Error('Image node missing')
  }
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(1, undefined, {
      ...node.attrs,
      width: 640,
      height: 320,
      alt: 'Offscreen'
    })
  )
  expect(image.parentElement?.style.width).toBe('640px')
  expect(image.parentElement?.style.aspectRatio).toBe('640 / 320')
  expect(image.alt).toBe('Offscreen')
  expect(readFile).not.toHaveBeenCalled()
  ImageVisibilityObserver.current.emit(image, true)
  await settle()
  image.dispatchEvent(new Event('load'))
  expect(image.parentElement?.style.width).toBe('')
  ImageVisibilityObserver.current.emit(image, false)
  expect(image.parentElement?.style.width).toBe('640px')
  expect(image.getAttribute('width')).toBe('640')
  expect(image.getAttribute('height')).toBe('320')
})

it('does not retry missing files on unrelated viewport ownership changes', async () => {
  readFile.mockResolvedValueOnce({ content: '', isBinary: false })
  const { images } = mountImages(2)
  const first = images[0]
  const second = images[1]
  if (!first || !second) {
    throw new Error('Images missing')
  }
  ImageVisibilityObserver.current.emit(first, true)
  await settle()
  ImageVisibilityObserver.current.emit(second, true)
  await settle()
  ImageVisibilityObserver.current.emit(second, false)
  await settle()
  expect(first.hasAttribute('src')).toBe(false)
  expect(readFile).toHaveBeenCalledTimes(2)
})

it('removes external image sources while document ownership is unresolved and recovers on resolution', () => {
  const { editor, images } = mountImages(1)
  const image = images[0]
  if (!image) {
    throw new Error('Image missing')
  }
  const node = editor.state.doc.nodeAt(1)
  if (!node) {
    throw new Error('Image node missing')
  }
  setRichMarkdownImageResolverContext(editor, {
    filePath: '/folder/docs/readme.md',
    runtimeContext: null
  })
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(1, undefined, {
      ...node.attrs,
      src: 'https://example.com/image.png'
    })
  )
  expect(image.hasAttribute('src')).toBe(false)
  setRichMarkdownImageResolverContext(editor, { filePath: '/folder/docs/readme.md' })
  expect(image.getAttribute('src')).toBe('https://example.com/image.png')
  setRichMarkdownImageResolverContext(editor, {
    filePath: '/folder/docs/readme.md',
    runtimeContext: null
  })
  expect(image.hasAttribute('src')).toBe(false)
  expect(readFile).not.toHaveBeenCalled()
})
