import { afterEach, expect, it } from 'vitest'
import {
  getCachedMarkdownRichModeEligibility,
  resetMarkdownRichModeEligibilityCache
} from './markdown-rich-mode-eligibility-cache'

afterEach(resetMarkdownRichModeEligibilityCache)

function collectHeap(): number {
  if (!globalThis.gc) {
    throw new Error('Forced GC unavailable; config/vitest.config.ts must pass --expose-gc')
  }
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

function classifyLargeDocument(index: number): number {
  const content = (String.fromCharCode(97 + index) + 'q'.repeat(4 * 1024 * 1024 - 1)).toUpperCase()
  const startedAt = performance.now()
  const result = getCachedMarkdownRichModeEligibility({ content, sizeOverridden: false })
  const elapsedMs = performance.now() - startedAt
  expect(result.exceedsSizeLimit).toBe(true)
  return elapsedMs
}

it('releases documents beyond the hard render cap after callers drop them', () => {
  classifyLargeDocument(0)
  resetMarkdownRichModeEligibilityCache()
  const baseline = collectHeap()

  let classificationMs = 0
  for (let index = 0; index < 4; index += 1) {
    classificationMs += classifyLargeDocument(index)
  }
  const retainedBytes = collectHeap() - baseline
  console.log(
    JSON.stringify({ documents: 4, sourceBytes: 16 * 1024 * 1024, retainedBytes, classificationMs })
  )

  expect(retainedBytes).toBeLessThan(2 * 1024 * 1024)
})
