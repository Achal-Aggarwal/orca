// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('pdfjs-dist', () => ({
  PDFDataRangeTransport: class {
    constructor(
      readonly length: number,
      readonly initialData: unknown
    ) {}
    onDataRange(_begin: number, _chunk: Uint8Array): void {}
  }
}))

import { createOrcaMediaRangeTransport } from './pdf-orca-media-range-transport'

afterEach(() => vi.unstubAllGlobals())

describe('orca-media range transport for pdf.js', () => {
  it('fetches each range pdf.js asks for and hands back its bytes', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([7, 8, 9]), { status: 206 }))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createOrcaMediaRangeTransport('orca-media://file/doc', 100, vi.fn())
    const onDataRange = vi.spyOn(transport, 'onDataRange')

    transport.requestDataRange(10, 13)

    await vi.waitFor(() => expect(onDataRange).toHaveBeenCalledWith(10, new Uint8Array([7, 8, 9])))
    expect(fetchMock).toHaveBeenCalledWith(
      'orca-media://file/doc',
      expect.objectContaining({ headers: { Range: 'bytes=10-12' } })
    )
    expect(transport.length).toBe(100)
  })

  it('reports a failed range instead of leaving pdf.js waiting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 502 }))
    )
    const onFailure = vi.fn()
    createOrcaMediaRangeTransport('orca-media://file/doc', 100, onFailure).requestDataRange(0, 10)

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce())
  })
})
