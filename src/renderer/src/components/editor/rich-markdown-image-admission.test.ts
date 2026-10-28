// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { prewarmMarkdownPreviewLocalImages } from './markdown-preview-local-images'
import {
  invalidateLocalImageSrcCacheForTests,
  loadLocalImageSrc,
  resetLocalImageSrcStateForTests
} from './useLocalImageSrc'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-read-client'

vi.mock('@/runtime/runtime-file-read-client', () => ({ readRuntimeFilePreview: vi.fn() }))

type PreviewResult = Awaited<ReturnType<Window['api']['fs']['readFile']>>
type PendingRead = { path: string; resolve: (result: PreviewResult) => void }
const pendingReads: PendingRead[] = []
const editors: Editor[] = []
const controllers: AbortController[] = []
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const readFile = vi.fn(
  ({ filePath }: { filePath: string; connectionId?: string }) =>
    new Promise<PreviewResult>((resolve) => pendingReads.push({ path: filePath, resolve }))
)

async function flushReads(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function settleRead(path: string, binary = false): void {
  const index = pendingReads.findIndex((read) => read.path === path)
  if (index === -1) {
    throw new Error(`No active read for ${path}`)
  }
  const read = pendingReads.splice(index, 1)[0]
  read.resolve({ content: binary ? 'AA==' : '', isBinary: binary, mimeType: 'image/png' })
}

function mountDocument(markdown: string, resolve = true) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: markdown,
    contentType: 'markdown'
  })
  editors.push(editor)
  if (resolve) {
    setRichMarkdownImageResolverContext(editor, { filePath: '/repo/docs/readme.md' })
  }
  return { editor, host }
}

async function saturateLocalReads(): Promise<void> {
  const controller = new AbortController()
  controllers.push(controller)
  for (let index = 0; index < 4; index += 1) {
    void loadLocalImageSrc(
      `blocker-${index}.png`,
      '/repo/docs/readme.md',
      undefined,
      undefined,
      undefined,
      controller.signal
    )
  }
  await flushReads()
  expect(readFile).toHaveBeenCalledTimes(4)
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  readFile.mockClear()
  vi.mocked(readRuntimeFilePreview).mockReset()
  Object.defineProperty(window, 'api', { value: { fs: { readFile } }, configurable: true })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:admitted-image')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(async () => {
  for (const editor of editors.splice(0)) {
    if (!editor.isDestroyed) {
      editor.destroy()
    }
  }
  for (const controller of controllers.splice(0)) {
    controller.abort()
  }
  resetLocalImageSrcStateForTests()
  for (const read of pendingReads.splice(0)) {
    read.resolve({ content: '', isBinary: false })
  }
  await flushReads()
  vi.restoreAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
  document.body.innerHTML = ''
})

describe('rich markdown image read admission', () => {
  it.each([100, 1_000])(
    'bounds the production read burst for %i distinct images',
    async (count) => {
      const document = mountDocument(
        Array.from({ length: count }, (_, index) => `![](image-${index}.png)`).join('\n\n'),
        false
      )
      expect(document.host.querySelectorAll('img')).toHaveLength(count)
      expect(readFile).not.toHaveBeenCalled()
      setRichMarkdownImageResolverContext(document.editor, { filePath: '/repo/docs/readme.md' })
      await flushReads()
      console.info(JSON.stringify({ population: count, startedReads: readFile.mock.calls.length }))
      expect(readFile).toHaveBeenCalledTimes(4)

      document.editor.destroy()
      mountDocument('![](live.png)')
      await flushReads()
      expect(readFile).toHaveBeenCalledTimes(4)
      settleRead('/repo/docs/image-0.png', true)
      await flushReads()
      expect(readFile).toHaveBeenCalledTimes(5)
      expect(URL.createObjectURL).not.toHaveBeenCalled()
      expect(readFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ filePath: '/repo/docs/live.png' })
      )
    }
  )

  it.each(['display', 'prewarm'])(
    'preserves the other owner when a shared %s closes',
    async (owner) => {
      await saturateLocalReads()
      const prewarm = prewarmMarkdownPreviewLocalImages('![](shared.png)', '/repo/docs/readme.md')
      const document = mountDocument('![](shared.png)')
      if (owner === 'display') {
        document.editor.destroy()
      } else {
        prewarm.cancel()
      }
      settleRead('/repo/docs/blocker-0.png')
      await flushReads()
      expect(readFile).toHaveBeenCalledTimes(5)
      expect(readFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ filePath: '/repo/docs/shared.png' })
      )
      settleRead('/repo/docs/shared.png', true)
      await prewarm.done
      await flushReads()
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
      if (owner === 'prewarm') {
        expect(document.host.querySelector('img')?.src).toBe('blob:admitted-image')
      }
    }
  )

  it('removes a canceled prewarm from the shared admission queue', async () => {
    await saturateLocalReads()
    const prewarm = prewarmMarkdownPreviewLocalImages('![](obsolete.png)', '/repo/docs/readme.md')
    prewarm.cancel()
    await prewarm.done
    settleRead('/repo/docs/blocker-0.png')
    await flushReads()
    expect(readFile).toHaveBeenCalledTimes(4)
  })

  it('lets a new display replace an abandoned queued read for the same key', async () => {
    await saturateLocalReads()
    const old = mountDocument('![](replacement.png)')
    old.editor.destroy()
    const next = mountDocument('![](replacement.png)')
    settleRead('/repo/docs/blocker-0.png')
    await flushReads()
    expect(readFile).toHaveBeenCalledTimes(5)
    settleRead('/repo/docs/replacement.png', true)
    await flushReads()
    expect(next.host.querySelector('img')?.src).toBe('blob:admitted-image')
  })

  it('drops invalidated queued reads and admits a new generation after active I/O settles', async () => {
    await saturateLocalReads()
    const stale = loadLocalImageSrc('invalidated.png', '/repo/docs/readme.md')
    invalidateLocalImageSrcCacheForTests()
    await expect(stale).resolves.toBeNull()
    const fresh = loadLocalImageSrc('fresh.png', '/repo/docs/readme.md')
    await flushReads()
    expect(readFile).toHaveBeenCalledTimes(4)
    settleRead('/repo/docs/blocker-0.png')
    await flushReads()
    expect(readFile).toHaveBeenCalledTimes(5)
    settleRead('/repo/docs/fresh.png', true)
    await expect(fresh).resolves.toBe('blob:admitted-image')
  })

  it('keeps fresh nodeview reloads created during cache invalidation', async () => {
    const document = mountDocument('![](reloaded.png)')
    await flushReads()
    settleRead('/repo/docs/reloaded.png', true)
    await flushReads()
    expect(document.host.querySelector('img')?.src).toBe('blob:admitted-image')
    invalidateLocalImageSrcCacheForTests()
    await flushReads()
    expect(readFile).toHaveBeenCalledTimes(2)
    settleRead('/repo/docs/reloaded.png', true)
    await flushReads()
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    expect(document.host.querySelector('img')?.src).toBe('blob:admitted-image')
  })

  it('keeps local and healthy runtime reads independent of a hung runtime', async () => {
    vi.mocked(readRuntimeFilePreview).mockImplementation((_context, filePath) =>
      readFile({ filePath })
    )
    const controller = new AbortController()
    controllers.push(controller)
    for (const environmentId of ['hung', 'healthy']) {
      for (let index = 0; index < 5; index += 1) {
        void loadLocalImageSrc(
          `${environmentId}-${index}.png`,
          '/repo/docs/readme.md',
          undefined,
          {
            target: { kind: 'environment', environmentId },
            worktreeId: 'folder',
            worktreePath: '/repo'
          },
          undefined,
          controller.signal
        )
      }
    }
    mountDocument('![](local.png)')
    await flushReads()
    expect(readRuntimeFilePreview).toHaveBeenCalledTimes(8)
    expect(readFile).toHaveBeenCalledTimes(9)
    settleRead('/repo/docs/healthy-0.png')
    settleRead('/repo/docs/local.png', true)
    await flushReads()
    expect(readRuntimeFilePreview).toHaveBeenCalledTimes(9)
    expect(readFile).toHaveBeenLastCalledWith({ filePath: '/repo/docs/healthy-4.png' })
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })
})
