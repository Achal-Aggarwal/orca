// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDocument } = vi.hoisted(() => ({
  getDocument: vi.fn((_options: Record<string, unknown>) => ({
    promise: new Promise(() => {}),
    destroy: vi.fn(async () => {})
  }))
}))
vi.mock('pdfjs-dist', () => ({
  getDocument,
  PDFDataRangeTransport: class {
    constructor(readonly length: number) {}
  }
}))

import { createPdfDocumentLoader } from './pdf-document-loader'

describe('PDF document loader sources', () => {
  beforeEach(() => {
    getDocument.mockClear()
  })

  it('reads a sized URL by range, and still decodes base64 for diffs and the web client', () => {
    const loader = createPdfDocumentLoader({ display: () => () => {}, onError: vi.fn() })
    loader.load({ url: 'orca-media://file/doc?revision=r1' })
    expect(getDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'orca-media://file/doc?revision=r1' })
    )
    expect(getDocument.mock.lastCall?.[0]).not.toHaveProperty('data')

    loader.load({ url: 'orca-media://file/doc?revision=r2', length: 4096 })
    expect(getDocument.mock.lastCall?.[0]).toMatchObject({ range: { length: 4096 } })
    expect(getDocument.mock.lastCall?.[0]).not.toHaveProperty('url')

    loader.load({ base64: 'JVBERg==' })
    expect(getDocument.mock.lastCall?.[0]).toMatchObject({
      data: new Uint8Array([0x25, 0x50, 0x44, 0x46])
    })
    loader.dispose()
  })
})
