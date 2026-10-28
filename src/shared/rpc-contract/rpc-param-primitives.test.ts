import { describe, expect, it } from 'vitest'
import { compile, z } from 'zod'
import { requiredNumber, requiredString, requiredStringAllowingEmpty } from './rpc-param-primitives'

describe('required RPC primitive schemas', () => {
  it.each([requiredString, requiredStringAllowingEmpty, requiredNumber])(
    'reuses schemas for the same message without conflating different messages',
    (factory) => {
      const first = factory('Missing id')
      expect(factory('Missing id') === first).toBe(true)
      expect(factory('Missing name') === first).toBe(false)
    }
  )

  it('keeps empty-string and number validation distinct for an identical message', () => {
    const strict = requiredString('Missing value')
    const empty = requiredStringAllowingEmpty('Missing value')
    const number = requiredNumber('Missing value')
    expect(strict.safeParse('').success).toBe(false)
    expect(empty.parse('')).toBe('')
    expect(empty.safeParse(1).success).toBe(false)
    expect(number.parse(1)).toBe(1)
    expect(number.safeParse('1').success).toBe(false)
    expect(number.safeParse(Number.POSITIVE_INFINITY).success).toBe(false)
    expect(strict.parse(' ')).toBe(' ')
  })

  it.each([false, true])(
    'preserves independent issue paths and optionality (compiled: %s)',
    (jit) => {
      const value = requiredString('Missing value')
      const schema = z.object({ left: value, right: value.optional() })
      const parser = jit ? compile(schema) : schema
      const result = parser.safeParse({ left: null, right: 1 })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(
          result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))
        ).toEqual([
          { path: ['left'], message: 'Missing value' },
          { path: ['right'], message: 'Missing value' }
        ])
      }
      expect(parser.parse({ left: 'a', right: 'b' })).toEqual({ left: 'a', right: 'b' })
      expect(parser.parse({ left: 'a' })).toEqual({ left: 'a' })
      expect(value.safeParse(undefined).success).toBe(false)
    }
  )

  it.each([requiredString, requiredStringAllowingEmpty, requiredNumber])(
    'bounds cached messages without changing rebuilt validators',
    (factory) => {
      const first = factory('cache-oldest')
      for (let index = 0; index < 256; index++) {
        factory(`cache-${index}`)
      }
      const rebuilt = factory('cache-oldest')
      expect(rebuilt === first).toBe(false)
      expect(rebuilt.safeParse(null)).toEqual(first.safeParse(null))
    }
  )
})
