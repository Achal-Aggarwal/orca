import { afterEach, describe, expect, it, vi } from 'vitest'
import { findTextMatchRanges } from './markdown-preview-search'

afterEach(() => vi.restoreAllMocks())

describe('locale folding across ASCII runs in Unicode text', () => {
  it.each([10_000, 100_000])(
    'folds %i ASCII characters next to an emoji in one locale conversion',
    (count) => {
      const text = `😊${'A'.repeat(count)} needle`
      const lowercase = vi.spyOn(String.prototype, 'toLocaleLowerCase')
      expect(findTextMatchRanges(text, 'needle')).toEqual([{ start: count + 3, end: count + 9 }])
      expect(lowercase).toHaveBeenCalledTimes(3)
    }
  )

  it.each([
    { locale: 'en-US', dotted: [0, 1, 2, 4, 5], dotless: [7] },
    { locale: 'tr', dotted: [1, 4], dotless: [0, 2, 5, 7] },
    { locale: 'az', dotted: [1, 4], dotless: [0, 2, 5, 7] },
    { locale: 'lt', dotted: [0, 1, 2, 4, 5], dotless: [7] },
    { locale: 'el', dotted: [0, 1, 2, 4, 5], dotless: [7] }
  ])(
    'preserves source offsets and character-wise casing across runs in $locale',
    ({ locale, dotted, dotless }) => {
      const lowercase = String.prototype.toLocaleLowerCase
      vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
        return lowercase.call(this, locale)
      })
      expect(findTextMatchRanges('IİI iI ı', 'i')).toEqual(
        dotted.map((start) => ({ start, end: start + 1 }))
      )
      expect(findTextMatchRanges('IİI iI ı', 'ı')).toEqual(
        dotless.map((start) => ({ start, end: start + 1 }))
      )
      expect(findTextMatchRanges('AΣ Aς Aσ', 'aσ')).toEqual([
        { start: 0, end: 2 },
        { start: 6, end: 8 }
      ])
      expect(findTextMatchRanges('aa😊bb', '\ud83d')).toEqual([{ start: 2, end: 4 }])
      expect(findTextMatchRanges('aa😊bb', '\ude0a')).toEqual([{ start: 2, end: 4 }])
    }
  )
})
