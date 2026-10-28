import { expect, it } from 'vitest'
import { StatusPorcelainParser } from './git-status-porcelain-parser'

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

function parseSnapshot(index: number): StatusPorcelainParser {
  const parser = new StatusPorcelainParser()
  const hash = 'a'.repeat(40)
  const records = [
    `# branch.oid ${hash}`,
    '# branch.head feature/status-storage',
    '# branch.upstream origin/feature/status-storage',
    '# branch.ab +2 -1',
    ...Array.from(
      { length: 350 },
      (_, row) =>
        `1 .M N... 100644 100644 100644 ${hash} ${hash} src/snapshot-${index}/module-${row}/document.ts`
    ),
    `2 R. N... 100644 100644 100644 ${hash} ${hash} R100 src/renamed-document.ts\tsrc/original-document.ts`,
    `u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} src/conflicted-document.ts`,
    '! build/generated-documents/',
    '? src/untracked-document.ts',
    '? src/unfinished-document'
  ]
  parser.update(records.join('\r\n'), 0)
  return parser
}

it('owns parsed status strings while a partial final record is pending', () => {
  for (let index = 0; index < 4; index += 1) {
    parseSnapshot(index)
  }
  const snapshots: StatusPorcelainParser[] = []
  const before = collectHeap()
  for (let index = 0; index < 64; index += 1) {
    snapshots.push(parseSnapshot(index))
  }
  const retained = collectHeap() - before

  expect(retained).toBeLessThan(5 * 1024 * 1024)
  for (const [index, parser] of snapshots.entries()) {
    parser.update('.ts\n', 0)
    parser.finish()
    expect(parser.entries).toHaveLength(353)
    expect(parser.entries[0].path).toBe(`src/snapshot-${index}/module-0/document.ts`)
    expect(parser.entries.at(-1)?.path).toBe('src/unfinished-document.ts')
    expect(parser.branch.branch).toBe('refs/heads/feature/status-storage')
    expect(parser.ignoredPaths).toEqual(['build/generated-documents/'])
    expect(parser.unmergedLines).toHaveLength(1)
  }
})
