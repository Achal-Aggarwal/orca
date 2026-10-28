import { describe, expect, it, vi } from 'vitest'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from './node-bounded-json-stringify'

describe('stringifyJsonWithinByteLimit', () => {
  it('matches native JSON for nested values, escaping, and omitted fields', () => {
    const shared = { label: 'same object' }
    const value = {
      text: 'quote " slash \\ control\n emoji 🐋 lone \ud800',
      nested: [1, undefined, Number.NaN, { omitted: undefined, kept: true }],
      repeated: [shared, shared]
    }
    const native = JSON.stringify(value)

    const result = stringifyJsonWithinByteLimit(value, Buffer.byteLength(native))

    expect(result.serialized).toBe(native)
    expect(result.byteLength).toBe(Buffer.byteLength(native, 'utf8'))
    expect(() => stringifyJsonWithinByteLimit(value, result.byteLength - 1)).toThrow(
      JsonStringifyByteLimitError
    )
  })

  it('matches native indented JSON and counts whitespace before materializing it', () => {
    const value = { nested: [{ quote: '"', unicode: '🐋' }], empty: {} }
    const native = JSON.stringify(value, null, 2)

    expect(stringifyJsonWithinByteLimit(value, Buffer.byteLength(native), 2)).toEqual({
      byteLength: Buffer.byteLength(native),
      serialized: native
    })
    expect(() => stringifyJsonWithinByteLimit(value, Buffer.byteLength(native) - 1, 2)).toThrow(
      JsonStringifyByteLimitError
    )
  })

  it('matches native numeric and string indentation normalization', () => {
    const value = { nested: { value: true } }
    for (const space of [Number.NaN, -1, 20, '🐋'.repeat(6)]) {
      const native = JSON.stringify(value, null, space)
      expect(stringifyJsonWithinByteLimit(value, Buffer.byteLength(native), space)).toEqual({
        byteLength: Buffer.byteLength(native),
        serialized: native
      })
    }
  })

  it('stops visiting indented collections when whitespace crosses the limit', () => {
    let visits = 0
    const value = Array.from({ length: 10_000 }, () => ({
      toJSON() {
        visits += 1
        return 1
      }
    }))

    expect(() => stringifyJsonWithinByteLimit(value, 64, 2)).toThrow(JsonStringifyByteLimitError)
    expect(visits).toBeLessThan(value.length)
  })

  it('measures values after toJSON without invoking it twice', () => {
    let calls = 0
    const value = {
      toJSON() {
        calls += 1
        return { rendered: 'value' }
      }
    }

    expect(stringifyJsonWithinByteLimit(value, 100).serialized).toBe('{"rendered":"value"}')
    expect(calls).toBe(1)
  })

  it('rejects a large root string before materializing escaped JSON', () => {
    const value = '\n'.repeat(1024 * 1024)

    expect(() => stringifyJsonWithinByteLimit(value, 1024)).toThrow(JsonStringifyByteLimitError)
  })

  it('stops visiting a large collection as soon as it crosses the limit', () => {
    let visits = 0
    const value = Array.from({ length: 10_000 }, () => ({
      toJSON() {
        visits += 1
        return 1
      }
    }))

    expect(() => stringifyJsonWithinByteLimit(value, 64)).toThrow(JsonStringifyByteLimitError)
    expect(visits).toBeLessThan(value.length)
  })

  it('measures raw JSON values before native serialization materializes them', () => {
    const createRawJson = (JSON as { rawJSON?: (value: string) => unknown }).rawJSON
    if (!createRawJson) {
      return
    }
    const value = createRawJson(JSON.stringify('x'.repeat(1024)))

    expect(() => stringifyJsonWithinByteLimit(value, 32)).toThrow(JsonStringifyByteLimitError)
  })

  it('rejects invalid limits and unserializable roots like native JSON', () => {
    expect(() => stringifyJsonWithinByteLimit('value', -1)).toThrow(RangeError)
    expect(() => stringifyJsonWithinByteLimit(undefined, 100)).toThrow(TypeError)
  })
  it('counts native-encoded strings across UTF-16 and without the Node Buffer global', () => {
    const text = Array.from({ length: 65_536 }, (_, code) => String.fromCharCode(code)).join('')
    const value = { text }
    const serialized = JSON.stringify(value)
    const expected = { serialized, byteLength: Buffer.byteLength(serialized, 'utf8') }
    expect(stringifyJsonWithinByteLimit(value, 1024 * 1024)).toEqual(expected)
    let browserResult: ReturnType<typeof stringifyJsonWithinByteLimit> | undefined
    try {
      vi.stubGlobal('Buffer', undefined)
      browserResult = stringifyJsonWithinByteLimit(value, 1024 * 1024)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(browserResult).toEqual(expected)
  })

  it('stops before later getters when a bounded native string crosses the remaining budget', () => {
    let visited = false
    const value = {
      text: '\0'.repeat(10),
      get later() {
        visited = true
        return true
      }
    }
    expect(() => stringifyJsonWithinByteLimit(value, 64)).toThrow(JsonStringifyByteLimitError)
    expect(visited).toBe(false)
  })
})
