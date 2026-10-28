import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runBundledRipgrepTextSearch } from './bundled-ripgrep-text-search'

it('returns bounded, navigable results when a legal dense file emits more than 64 MiB of JSON', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'orca-dense-json-'))
  const resultRootPath = join(rootPath, 'lexical-root')
  const release = vi.fn()
  let outputBytes = 0
  try {
    await writeFile(join(rootPath, 'dense.txt'), `${'x '.repeat(1_300_000)}\n`)
    const result = await runBundledRipgrepTextSearch({
      rootPath,
      resultRootPath,
      options: { rootPath: resultRootPath, query: 'x' },
      onSpawn: (child) => {
        const countOutput = (chunk: string): void => {
          outputBytes += Buffer.byteLength(chunk)
        }
        child.stdout?.on('data', countOutput)
        return () => {
          child.stdout?.off('data', countOutput)
          release()
        }
      }
    })
    expect(outputBytes).toBeGreaterThan(64 * 1024 * 1024)
    expect(result.totalMatches).toBe(2000)
    expect(result.truncated).toBe(true)
    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.filePath).toBe(join(resultRootPath, 'dense.txt'))
    expect(file.matches[0]).toMatchObject({ line: 1, column: 1, matchLength: 1 })
    expect(file.matches[1999]).toMatchObject({ line: 1, column: 3999, matchLength: 1 })
    expect(release).toHaveBeenCalledOnce()
  } finally {
    await rm(rootPath, { recursive: true, force: true })
  }
}, 60_000)
