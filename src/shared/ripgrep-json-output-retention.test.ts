import { expect, it } from 'vitest'
import { RipgrepJsonOutputDecoder } from './ripgrep-json-output'
import { SEARCH_JSON_STRUCTURE_LIMITS } from './text-search'

function collectedBytes(): number {
  if (!globalThis.gc) {
    throw new Error('This regression requires --expose-gc')
  }
  void /reset/.test('reset')
  globalThis.gc()
  globalThis.gc()
  const memory = process.memoryUsage()
  return memory.heapUsed + memory.external
}

function pendingDenseRecord() {
  let accepted = 0
  const decoder = new RipgrepJsonOutputDecoder({
    limits: SEARCH_JSON_STRUCTURE_LIMITS,
    maxMatches: () => 2000,
    onRecord: () => {
      accepted++
      return 'continue'
    },
    onInvalid: () => {
      throw new Error('The generated record must remain valid')
    }
  })
  const header = JSON.stringify({
    type: 'match',
    data: { path: { text: 'dense.txt' }, lines: { text: 'x '.repeat(1_300_000) } }
  })
  decoder.push(`${header.slice(0, -2)},"submatches":[`)
  for (let start = 0; start < 300_000; start += 1000) {
    const ranges = Array.from({ length: 1000 }, (_, index) => ({
      match: { text: 'x' },
      start: (start + index) * 2,
      end: (start + index) * 2 + 1
    }))
    decoder.push(`${start === 0 ? '' : ','}${JSON.stringify(ranges).slice(1, -1)}`)
  }
  return { decoder, accepted: () => accepted }
}

it('retains the projected line and requested ranges while a dense record is unfinished', () => {
  pendingDenseRecord().decoder.clear()
  const before = collectedBytes()
  const pending = pendingDenseRecord()
  expect(pending.accepted()).toBe(0)
  expect(collectedBytes() - before).toBeLessThan(12 * 1024 * 1024)
  pending.decoder.clear()
  expect(collectedBytes() - before).toBeLessThan(4 * 1024 * 1024)
  pending.decoder.push('{}\n')
  expect(pending.accepted()).toBe(1)
})
