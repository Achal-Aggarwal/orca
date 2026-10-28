import { afterEach, describe, expect, it, vi } from 'vitest'
import { findTextMatchRanges } from './markdown-preview-search'

const lowercase = String.prototype.toLocaleLowerCase

afterEach(() => vi.restoreAllMocks())

function countNumericAppends(text: string, query: string) {
  const push = Array.prototype.push
  let slots = 0
  Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
    if (items.every((item) => typeof item === 'number')) {
      slots += items.length
    }
    return push.apply(this, items)
  }
  try {
    const matches = findTextMatchRanges(text, query)
    return { matches, slots }
  } finally {
    Array.prototype.push = push
  }
}

describe('locale search offset spans', () => {
  it.each([10_000, 100_000])(
    'stores only one exceptional span beside %i ordinary characters',
    (count) => {
      for (const text of [`😀${'a'.repeat(count)} needle`, `${'a'.repeat(count)}😀 needle`]) {
        const result = countNumericAppends(text, 'needle')
        expect(result.matches).toEqual([{ start: count + 3, end: count + 9 }])
        expect(result.slots).toBe(4)
      }
    }
  )

  it('preserves complete source characters for matches inside surrogate pairs and expansions', () => {
    vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
      return lowercase.call(this, 'en-US')
    })
    const text = '😀AİB𐐀C'
    for (const query of ['😀', '\ud83d', '\ude00']) {
      expect(findTextMatchRanges(text, query)).toEqual([{ start: 0, end: 2 }])
    }
    for (const query of ['i', '\u0307']) {
      expect(findTextMatchRanges(text, query)).toEqual([{ start: 3, end: 4 }])
    }
    expect(findTextMatchRanges(text, 'i\u0307b')).toEqual([{ start: 3, end: 5 }])
    for (const query of ['𐐨', '\ud801', '\udc28']) {
      expect(findTextMatchRanges(text, query)).toEqual([{ start: 5, end: 7 }])
    }
    expect(findTextMatchRanges(text, 'b𐐨c')).toEqual([{ start: 4, end: 8 }])
    expect(findTextMatchRanges('\ud83dA\ude00İ', '\ude00')).toEqual([{ start: 2, end: 3 }])
  })

  it.each(['tr', 'az'])('keeps %s locale offsets when casing does not expand', (locale) => {
    vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
      return lowercase.call(this, locale)
    })
    const text = 'AİI😀B'
    expect(findTextMatchRanges(text, 'i')).toEqual([{ start: 1, end: 2 }])
    expect(findTextMatchRanges(text, 'ı')).toEqual([{ start: 2, end: 3 }])
    expect(findTextMatchRanges(text, 'b')).toEqual([{ start: 5, end: 6 }])
  })

  it('keeps dense exceptional input linear and does not index ordinary BMP characters', () => {
    const count = 1_000
    const dense = countNumericAppends('😀'.repeat(count), '😀')
    expect(dense.matches).toHaveLength(count)
    expect(dense.matches.at(-1)).toEqual({ start: (count - 1) * 2, end: count * 2 })
    expect(dense.slots).toBe((count + 1) * 4)
    expect(countNumericAppends('Ééß', 'é').slots).toBe(0)
  })
})
