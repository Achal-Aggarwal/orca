import { afterEach, expect, it, vi } from 'vitest'
import { advancePartialEscapeTail } from './terminal-partial-escape-tail'
import { resetOwnRetainedStringCopier } from './own-retained-string'

function collectHeap(): number {
  const gc = globalThis.gc
  if (!gc) {
    throw new Error('Retention checks require --expose-gc')
  }
  void /reset/.test('reset')
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetOwnRetainedStringCopier()
})

it.each(['node', 'bufferless'])(
  'owns pending escape tails in %s without retaining output',
  (runtime) => {
    if (runtime === 'bufferless') {
      vi.stubGlobal('Buffer', undefined)
    }
    resetOwnRetainedStringCopier()
    const chunkChars = 1024 * 1024
    const title = (index: number): string => `\x1b]0;pending-title-${index}-漢\ud800`
    for (let index = 0; index < 8; index += 1) {
      advancePartialEscapeTail('', `${'x'.repeat(chunkChars)}${title(index)}`)
    }
    const tails: string[] = []
    const before = collectHeap()
    for (let index = 0; index < 32; index += 1) {
      tails.push(
        advancePartialEscapeTail(
          '',
          `${String.fromCharCode(65 + index).repeat(chunkChars)}${title(index)}`
        )
      )
    }
    const retained = collectHeap() - before

    expect(retained).toBeLessThan(4 * 1024 * 1024)
    for (const [index, tail] of tails.entries()) {
      expect(tail).toBe(title(index))
      expect(advancePartialEscapeTail(tail, '\x07plain text')).toBe('')
      const continued = advancePartialEscapeTail(tail, ' continuation\udfff')
      expect(continued).toBe(`${title(index)} continuation\udfff`)
      expect(advancePartialEscapeTail(continued, '\x1b')).toBe('\x1b')
      expect(advancePartialEscapeTail('\x1b', '\\')).toBe('')
    }
  }
)
