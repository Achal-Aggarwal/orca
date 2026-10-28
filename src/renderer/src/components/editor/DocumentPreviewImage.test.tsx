// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DocumentPreviewImage } from './DocumentPreviewImage'
import { ImageVisibilityObserver } from './document-image-visibility.test-fixture'
import { resetLocalImageSrcStateForTests } from './useLocalImageSrc'
import { documentResourceAccess } from '@/lib/local-file-access'
import type { RichMarkdownImageRuntimeContext } from './rich-markdown-image-context'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-read-client'

vi.mock('@/runtime/runtime-file-read-client', () => ({ readRuntimeFilePreview: vi.fn() }))

type FileResult = Awaited<ReturnType<Window['api']['fs']['readFile']>>
const imageResult: FileResult = { content: 'AA==', isBinary: true, mimeType: 'image/png' }
const readFile = vi.fn<Window['api']['fs']['readFile']>()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
let root: Root
let host: HTMLDivElement

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 100; index += 1) {
      await Promise.resolve()
    }
  })
}

function image(): HTMLImageElement {
  const element = host.querySelector('img')
  if (!element) {
    throw new Error('Image missing')
  }
  return element
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', ImageVisibilityObserver)
  readFile.mockReset().mockResolvedValue(imageResult)
  vi.mocked(readRuntimeFilePreview).mockReset().mockResolvedValue(imageResult)
  Object.defineProperty(window, 'api', { configurable: true, value: { fs: { readFile } } })
  let urls = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${urls++}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  resetLocalImageSrcStateForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it('scopes visible folder-document reads and restores layout after leaving and revisiting', async () => {
  const access = documentResourceAccess('/folder/readme.md')
  const click = vi.fn()
  act(() =>
    root.render(
      <DocumentPreviewImage
        src="diagram.png"
        filePath="/folder/readme.md"
        access={access}
        width={640}
        height={320}
        alt="Diagram"
        onClick={click}
      />
    )
  )
  expect(readFile).not.toHaveBeenCalled()
  const element = image()
  expect(element.parentElement?.style.width).toBe('640px')
  ImageVisibilityObserver.current.emit(element, true)
  await settle()
  expect(readFile).toHaveBeenCalledWith({
    filePath: '/folder/diagram.png',
    connectionId: undefined,
    access
  })
  expect(element.src).toBe('blob:preview-0')
  element.dispatchEvent(new Event('load'))
  expect(element.parentElement?.style.width).toBe('')
  element.click()
  expect(click).toHaveBeenCalledOnce()
  ImageVisibilityObserver.current.emit(element, false)
  expect(element.hasAttribute('src')).toBe(false)
  expect(element.parentElement?.style.width).toBe('640px')
  await settle()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-0')
  act(() =>
    root.render(
      <DocumentPreviewImage
        src="diagram.png"
        filePath="/folder/readme.md"
        access={access}
        width={320}
        height={160}
        alt="Changed"
        onClick={click}
      />
    )
  )
  expect(image()).toBe(element)
  expect(element.parentElement?.style.width).toBe('320px')
  expect(element.parentElement?.style.aspectRatio).toBe('320 / 160')
  expect(element.alt).toBe('Changed')
  ImageVisibilityObserver.current.emit(element, true)
  await settle()
  expect(readFile).toHaveBeenCalledTimes(2)
  expect(element.src).toBe('blob:preview-1')
})

it('preserves equal rebuilt remote owners and rejects old-host results after an owner switch', async () => {
  const pending = Promise.withResolvers<FileResult>()
  vi.mocked(readRuntimeFilePreview).mockReturnValueOnce(pending.promise)
  const owner: RichMarkdownImageRuntimeContext = {
    target: { kind: 'environment', environmentId: 'remote-a' },
    worktreeId: 'folder',
    worktreePath: '/folder',
    expectedExecutionHostId: 'ssh:host-a'
  }
  const render = (runtimeContext: RichMarkdownImageRuntimeContext): void => {
    act(() =>
      root.render(
        <DocumentPreviewImage
          src="diagram.png"
          filePath="/folder/readme.md"
          runtimeContext={runtimeContext}
          access={documentResourceAccess('/folder/readme.md')}
          alt="Remote diagram"
        />
      )
    )
  }
  render(owner)
  ImageVisibilityObserver.current.emit(image(), true)
  await settle()
  expect(readRuntimeFilePreview).toHaveBeenCalledTimes(1)
  render({ ...owner, target: { ...owner.target } })
  await settle()
  expect(readRuntimeFilePreview).toHaveBeenCalledTimes(1)
  const nextOwner: RichMarkdownImageRuntimeContext = {
    ...owner,
    target: { kind: 'environment', environmentId: 'remote-b' },
    expectedExecutionHostId: 'ssh:host-b'
  }
  render(nextOwner)
  await settle()
  expect(readRuntimeFilePreview).toHaveBeenLastCalledWith(
    { ...nextOwner, connectionId: undefined },
    '/folder/diagram.png',
    documentResourceAccess('/folder/readme.md')
  )
  expect(image().src).toBe('blob:preview-0')
  pending.resolve(imageResult)
  await settle()
  expect(image().src).toBe('blob:preview-0')
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  expect(readFile).not.toHaveBeenCalled()
})

it('keeps external images blocked until the document owner resolves and removes them on owner loss', () => {
  const render = (runtimeContext: null | undefined): void => {
    act(() =>
      root.render(
        <DocumentPreviewImage
          src="https://example.com/diagram.png"
          filePath="/folder/readme.md"
          runtimeContext={runtimeContext}
          alt="External diagram"
        />
      )
    )
  }
  render(null)
  expect(image().hasAttribute('src')).toBe(false)
  render(undefined)
  expect(image().getAttribute('src')).toBe('https://example.com/diagram.png')
  render(null)
  expect(image().hasAttribute('src')).toBe(false)
  expect(readFile).not.toHaveBeenCalled()
  expect(readRuntimeFilePreview).not.toHaveBeenCalled()
})
