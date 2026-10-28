// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDocumentImageDisplay } from './document-image-display'
import { ImageVisibilityObserver } from './document-image-visibility.test-fixture'
import { getActiveMarkdownExportPayload } from './markdown-export-extract'
import { readLocalImagePreview } from './local-image-src-reader'
import { resetLocalImageSrcStateForTests } from './useLocalImageSrc'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openFiles: [{ id: 'document', filePath: '/repo/docs/readme.md', mode: 'edit' }]
    })
  }
}))
vi.mock('./local-image-src-reader', () => ({ readLocalImagePreview: vi.fn() }))

const imageResult = { content: 'AQID', isBinary: true, mimeType: 'image/png' }
const displays: ReturnType<typeof createDocumentImageDisplay>[] = []

function imageDocument(className: string, count: number) {
  const root = document.createElement('section')
  const source = document.createElement('div')
  source.className = className
  source.textContent = 'Exported document'
  root.append(source)
  document.body.append(root)
  for (let index = 0; index < count; index += 1) {
    const wrapper = document.createElement('span')
    const image = document.createElement('img')
    image.alt = `Diagram ${index}`
    wrapper.append(image)
    source.append(wrapper)
    displays.push(
      createDocumentImageDisplay(wrapper, image, {
        src: `./images/${index}.png`,
        filePath: '/repo/docs/readme.md',
        access: { kind: 'document-resource', documentPath: '/repo/docs/readme.md' }
      })
    )
  }
  return { root, source }
}

function exportDocument(root: Element) {
  return getActiveMarkdownExportPayload({ fileId: 'document', root })
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', ImageVisibilityObserver)
  resetLocalImageSrcStateForTests()
  vi.mocked(readLocalImagePreview).mockReset().mockResolvedValue(imageResult)
})

afterEach(() => {
  for (const display of displays.splice(0)) {
    display.destroy()
  }
  document.body.replaceChildren()
  resetLocalImageSrcStateForTests()
  vi.unstubAllGlobals()
})

it.each([
  ['ProseMirror', 10],
  ['ProseMirror', 100],
  ['markdown-body', 10],
  ['markdown-body', 100]
] as const)(
  'embeds every never-visible local image in %s with %s images',
  async (className, count) => {
    const { root, source } = imageDocument(className, count)
    expect(readLocalImagePreview).not.toHaveBeenCalled()
    expect(source.querySelectorAll('img[src]')).toHaveLength(0)

    const payload = await exportDocument(root)
    const exported = new DOMParser().parseFromString(payload?.html ?? '', 'text/html')

    expect(exported.querySelectorAll('img')).toHaveLength(count)
    expect(exported.querySelectorAll('img[src="data:image/png;base64,AQID"]')).toHaveLength(count)
    expect(exported.querySelector('img')?.alt).toBe('Diagram 0')
    expect(readLocalImagePreview).toHaveBeenCalledTimes(count)
    expect(readLocalImagePreview).toHaveBeenCalledWith(
      '/repo/docs/images/0.png',
      undefined,
      undefined,
      { kind: 'document-resource', documentPath: '/repo/docs/readme.md' }
    )
    expect(source.querySelectorAll('img[src]')).toHaveLength(0)
  }
)

it('stops failed export admission and lets a successor use the released slot', async () => {
  const first = Promise.withResolvers<Awaited<ReturnType<typeof readLocalImagePreview>>>()
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof readLocalImagePreview>>>()
  const read = vi.mocked(readLocalImagePreview)
  read.mockImplementation(() => pending.promise).mockImplementationOnce(() => first.promise)
  const { root } = imageDocument('ProseMirror', 12)
  const failed = exportDocument(root)
  const rejection = expect(failed).rejects.toThrow('read failed')
  try {
    await settle()
    expect(read).toHaveBeenCalledTimes(4)
    first.reject(new Error('read failed'))
    await rejection
    await settle()
    expect(read).toHaveBeenCalledTimes(4)

    read.mockResolvedValue(imageResult)
    const successor = imageDocument('markdown-body', 1)
    const payload = await exportDocument(successor.root)
    expect(read).toHaveBeenCalledTimes(5)
    expect(payload?.html).toContain('src="data:image/png;base64,AQID"')
  } finally {
    first.resolve(imageResult)
    pending.resolve(imageResult)
    await failed.catch(() => undefined)
    await rejection.catch(() => undefined)
    await settle()
  }
})

it('refuses an unresolved image owner and skips images inside export-only controls', async () => {
  const { root, source } = imageDocument('markdown-body', 0)
  const wrapper = document.createElement('span')
  const image = document.createElement('img')
  wrapper.append(image)
  source.append(wrapper)
  displays.push(
    createDocumentImageDisplay(wrapper, image, {
      src: './private.png',
      filePath: '/repo/docs/readme.md',
      runtimeContext: null
    })
  )
  await expect(exportDocument(root)).rejects.toThrow('document owner is resolved')
  expect(readLocalImagePreview).not.toHaveBeenCalled()

  wrapper.setAttribute('data-orca-export-hide', '')
  const payload = await exportDocument(root)
  expect(payload?.html).toContain('Exported document')
  expect(
    new DOMParser().parseFromString(payload?.html ?? '', 'text/html').querySelector('img')
  ).toBeNull()
  expect(readLocalImagePreview).not.toHaveBeenCalled()
})
