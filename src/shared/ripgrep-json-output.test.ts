import { describe, expect, it } from 'vitest'
import { RipgrepJsonOutputDecoder } from './ripgrep-json-output'
import { ingestRgMatchMessage } from './ripgrep-match-ingestion'
import { createAccumulator, SEARCH_JSON_STRUCTURE_LIMITS } from './text-search'

function createSearch(maxResults = 2) {
  const accumulator = createAccumulator()
  const decoder = new RipgrepJsonOutputDecoder({
    limits: SEARCH_JSON_STRUCTURE_LIMITS,
    maxMatches: () => maxResults - accumulator.totalMatches,
    onRecord: (record) => ingestRgMatchMessage(record, '/root', accumulator, maxResults),
    onInvalid: () => {
      accumulator.truncated = true
    }
  })
  return { accumulator, decoder }
}

function fragmentedRecord(): string {
  const prefix = 'é😀'.repeat(20_000)
  const text = `${prefix}needle needle needle\n`
  const offset = Buffer.byteLength(prefix)
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: './\ufeff😀.txt' },
      lines: { bytes: Buffer.from(text).toString('base64') },
      line_number: 4,
      submatches: [0, 7, 14].map((column) => ({
        match: { text: 'needle' },
        start: offset + column,
        end: offset + column + 6
      }))
    }
  })
}

describe('streaming search JSON records', () => {
  it.each([1, 7, 64 * 1024])(
    'keeps exact byte coordinates and Unicode identity across %i-code-unit chunks',
    (chunkSize) => {
      const { accumulator, decoder } = createSearch()
      const record = fragmentedRecord()
      for (let start = 0; start < record.length; start += chunkSize) {
        decoder.push(record.slice(start, start + chunkSize))
      }
      expect(accumulator.totalMatches).toBe(0)
      expect(decoder.finish()).toBe('stop')
      expect(accumulator.totalMatches).toBe(2)
      const file = accumulator.fileMap.get('/root/\ufeff😀.txt')
      expect(file?.matches.map((match) => [match.line, match.column, match.matchLength])).toEqual([
        [4, 60_001, 6],
        [4, 60_008, 6]
      ])
      for (const match of file?.matches ?? []) {
        expect(match.lineContent.isWellFormed()).toBe(true)
        expect(
          match.lineContent.slice(
            (match.displayColumn ?? match.column) - 1,
            (match.displayColumn ?? match.column) + 5
          )
        ).toBe('needle')
      }
    }
  )

  it.each([
    (record: string) => record.slice(0, -1),
    (record: string) => `${record.slice(0, -1)},"data":{}}`,
    (record: string) => `${record.slice(0, -2)},"submatches":[]}}`
  ])('rejects invalid tails before accepting ranges and resumes at the next record', (corrupt) => {
    const { accumulator, decoder } = createSearch()
    decoder.push(`${corrupt(fragmentedRecord())}\n`)
    expect(accumulator.totalMatches).toBe(0)
    expect(accumulator.truncated).toBe(true)
    expect(decoder.push(`${fragmentedRecord()}\n`)).toBe('stop')
    expect(accumulator.totalMatches).toBe(2)
  })

  it('discards an unfinished record on owner cleanup and stops before later output', () => {
    const { accumulator, decoder } = createSearch()
    const record = fragmentedRecord()
    decoder.push(record.slice(0, -1))
    decoder.clear()
    expect(decoder.push(`${record}\n${'x'.repeat(1024 * 1024)}`)).toBe('stop')
    expect(decoder.push('discarded after cap')).toBe('stop')
    expect(accumulator.totalMatches).toBe(2)
  })
})
