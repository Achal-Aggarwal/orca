export function buildPdfJsDocumentOptions(
  source: { data: Uint8Array } | { url: string },
  baseUrl: string
) {
  return {
    ...source,
    cMapUrl: new URL('cmaps/', baseUrl).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', baseUrl).href,
    wasmUrl: new URL('wasm/', baseUrl).href
  }
}
