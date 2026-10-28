import { PDFDataRangeTransport } from 'pdfjs-dist'

/**
 * pdf.js only fetches ranges over http(s); this reads an orca-media grant by range for it, so a
 * large local or remote PDF opens without being read whole first.
 */
export function createOrcaMediaRangeTransport(
  url: string,
  length: number,
  onFailure: (error: unknown) => void
): PDFDataRangeTransport {
  const controller = new AbortController()
  class OrcaMediaRangeTransport extends PDFDataRangeTransport {
    override requestDataRange(begin: number, end: number): void {
      void fetch(url, {
        headers: { Range: `bytes=${begin}-${end - 1}` },
        signal: controller.signal
      })
        .then(async (response) => {
          if (response.status !== 206) {
            throw new Error(`PDF range read failed (${response.status})`)
          }
          this.onDataRange(begin, new Uint8Array(await response.arrayBuffer()))
        })
        .catch((error: unknown) => {
          // pdf.js has no range-failure callback; without this it would wait forever.
          if (!controller.signal.aborted) {
            onFailure(error)
          }
        })
    }

    override abort(): void {
      controller.abort()
    }
  }
  return new OrcaMediaRangeTransport(length, null)
}
