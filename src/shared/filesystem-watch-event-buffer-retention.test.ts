import { expect, it } from 'vitest'
import type { FsChangeEvent } from './filesystem-entry-types'
import { FileWatchEventBuffer } from './filesystem-watch-event-buffer'

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 6; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function pushEvents(buffer: FileWatchEventBuffer, count: number): WeakRef<FsChangeEvent>[] {
  const references: WeakRef<FsChangeEvent>[] = []
  for (let index = 0; index < count; index++) {
    const event: FsChangeEvent = { kind: 'update', absolutePath: `/repo/file-${index}.ts` }
    references.push(new WeakRef(event))
    buffer.push([event])
  }
  return references
}

it.each([10_000, 100_000])(
  'releases discarded events after %i writes while overflow is pending',
  async (count) => {
    const buffer = new FileWatchEventBuffer()
    const references = pushEvents(buffer, count)
    await collect()
    expect(buffer.size).toBe(1)
    expect(references.filter((reference) => reference.deref())).toHaveLength(0)
    expect(buffer.take()).toEqual([{ kind: 'overflow', absolutePath: '/repo/file-5000.ts' }])
  }
)

it('retains a precise pending batch and releases it when its owner clears it', async () => {
  const buffer = new FileWatchEventBuffer()
  const references = pushEvents(buffer, 100)
  await collect()
  expect(references.filter((reference) => reference.deref())).toHaveLength(100)
  buffer.clear()
  await collect()
  expect(references.filter((reference) => reference.deref())).toHaveLength(0)
  expect(buffer.size).toBe(0)
})
