import { afterEach, describe, expect, it } from 'vitest'
import {
  getCachedMarkdownRichModeEligibility,
  resetMarkdownRichModeEligibilityCache
} from './markdown-rich-mode-eligibility-cache'

const DOCUMENT_CHARACTERS = 8 * 1024 * 1024
const DOCUMENTS = 4

function collectedHeap(): number {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with --expose-gc to measure retained document strings')
  }
  // Exclude the engine's legacy last-match input from the cache retention measurement.
  ;/(?:)/.test('')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

function classifyDocument(index: number, filler: string, cacheOwner = {}): void {
  const content = `---\npayload: ${filler.repeat(DOCUMENT_CHARACTERS)}\n---\nDocument ${index}.\n`
  const params = { content, sizeOverridden: false, cacheOwner }
  expect(getCachedMarkdownRichModeEligibility(params)).toEqual({
    exceedsSizeLimit: true,
    unsupportedMessage: null
  })
}

describe('markdown eligibility cache document retention', () => {
  afterEach(() => resetMarkdownRichModeEligibilityCache())

  it.each([
    ['one-byte', 'a'],
    ['two-byte', '漢']
  ])('releases %s contents after their file owners close', (label, filler) => {
    resetMarkdownRichModeEligibilityCache()
    classifyDocument(-1, filler)
    resetMarkdownRichModeEligibilityCache()
    const before = collectedHeap()
    for (let index = 0; index < DOCUMENTS; index++) {
      classifyDocument(index, filler)
    }
    const retainedBytes = collectedHeap() - before
    console.info(
      'MARKDOWN_ELIGIBILITY_RETENTION',
      JSON.stringify({ label, retainedBytes, DOCUMENTS })
    )
    expect(retainedBytes).toBeLessThan(DOCUMENT_CHARACTERS)
  })

  it('releases obsolete large drafts when their still-open owners contain small text again', () => {
    resetMarkdownRichModeEligibilityCache()
    const owners = Array.from({ length: DOCUMENTS }, () => ({}))
    const before = collectedHeap()
    owners.forEach((cacheOwner, index) => {
      classifyDocument(index, 'a', cacheOwner)
      expect(
        getCachedMarkdownRichModeEligibility({
          content: `Small document ${index}.`,
          sizeOverridden: false,
          cacheOwner
        })
      ).toEqual({ exceedsSizeLimit: false, unsupportedMessage: null })
    })
    expect(collectedHeap() - before).toBeLessThan(DOCUMENT_CHARACTERS)
    expect(owners).toHaveLength(DOCUMENTS)
  })
})
