import { describe, expect, it, vi } from 'vitest'
import type * as NodePath from 'node:path'

const host = vi.hoisted(() => ({ separator: '/' }))
vi.mock('node:path', async (importOriginal) => {
  const original = await importOriginal<typeof NodePath>()
  return {
    ...original,
    get sep() {
      return host.separator
    }
  }
})

import { findContainingSubmodule } from './submodule-paths'

describe('submodule path ownership on the execution host', () => {
  it.each([
    { separator: '/', file: 'vendor\\module/file.txt', expected: 'vendor\\module' },
    { separator: '/', file: 'vendor/module/file.txt', expected: 'vendor/module' },
    { separator: '\\', file: 'vendor\\module\\file.txt', expected: 'vendor/module' },
    { separator: '\\', file: 'vendor/module/file.txt', expected: 'vendor/module' }
  ])('matches $file with separator $separator', ({ separator, file, expected }) => {
    host.separator = separator
    expect(findContainingSubmodule(['vendor\\module', 'vendor/module'], file)).toBe(expected)
  })
})
