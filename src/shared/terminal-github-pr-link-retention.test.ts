import { afterEach, expect, it, vi } from 'vitest'
import { resetOwnRetainedStringCopier } from './own-retained-string'
import { createTerminalGitHubPRLinkDetector } from './terminal-github-pr-link-detector'

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

it.each([
  ['node', 'pu'],
  ['node', 'pull/4'],
  ['bufferless', 'pu'],
  ['bufferless', 'pull/4']
] as const)('retains unfinished PR URLs without consumed output in %s at %s', (runtime, path) => {
  if (runtime === 'bufferless') {
    vi.stubGlobal('Buffer', undefined)
  }
  resetOwnRetainedStringCopier()
  const before = collectHeap()
  const detectors = Array.from({ length: 32 }, (_, index) => {
    const detect = createTerminalGitHubPRLinkDetector()
    detect(
      `${String.fromCharCode(65 + index).repeat(1024 * 1024)} https://github.com/owner/repo/${path}`
    )
    return detect
  })
  const retainedBytes = collectHeap() - before
  expect(retainedBytes).toBeLessThan(4 * 1024 * 1024)
  for (const detect of detectors) {
    const suffix = path === 'pu' ? 'll/42\n' : '2\n'
    expect(detect(suffix)).toEqual([
      {
        url: 'https://github.com/owner/repo/pull/42',
        slug: { owner: 'owner', repo: 'repo', host: 'github.com' },
        number: 42
      }
    ])
    expect(detect('https://github.com/owner/repo/pull/42\n')).toEqual([])
  }
})
