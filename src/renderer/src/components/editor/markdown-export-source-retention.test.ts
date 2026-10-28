// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { getActiveMarkdownExportPayload } from './markdown-export-extract'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openFiles: [{ id: 'document', filePath: '/repo/readme.md', mode: 'edit' }]
    })
  }
}))

function closeExport(className: string) {
  const root = document.createElement('section')
  const source = document.createElement('div')
  source.className = className
  const text = document.createElement('p')
  text.textContent = `Exported content ${'x'.repeat(1024 * 1024)}`
  const image = document.createElement('img')
  image.src = 'blob:pending-export'
  source.append(text, image)
  root.append(source)
  document.body.append(root)
  const payload = getActiveMarkdownExportPayload({ fileId: 'document', root })
  root.remove()
  return { source: new WeakRef(source), payload }
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it.each(['ProseMirror', 'markdown-body'])(
  'releases closed %s source trees while its export images remain pending',
  async (className) => {
    const read = Promise.withResolvers<void>()
    const fetchImage = vi.fn(async () => {
      await read.promise
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'image/png' }
      })
    })
    vi.stubGlobal('fetch', fetchImage)
    const exports = Array.from({ length: 8 }, () => closeExport(className))
    try {
      await collect()
      expect(fetchImage).toHaveBeenCalledTimes(8)
      expect(exports.filter((entry) => entry.source.deref() !== undefined)).toHaveLength(0)
    } finally {
      read.resolve()
      const payloads = await Promise.all(exports.map((entry) => entry.payload))
      for (const payload of payloads) {
        expect(payload?.title).toBe('readme')
        expect(payload?.html).toContain('Exported content')
        expect(payload?.html).toContain('src="data:image/png;base64,AQID"')
      }
    }
  }
)
