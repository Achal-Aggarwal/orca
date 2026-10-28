import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Event as WatcherEvent } from '@parcel/watcher'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EventBatchModule from './filesystem-watcher-event-batch'
import type { WatcherEventBatchState } from './filesystem-watcher-event-batch'

const { spawnMock, queuedEventCounts } = vi.hoisted(() => {
  const queuedEventCounts: number[] = []
  return { spawnMock: vi.fn(), queuedEventCounts }
})

vi.mock('@orca/process-host', () => ({ spawnProcess: spawnMock }))
vi.mock('./filesystem-watcher-event-batch', async (importOriginal) => {
  const original = await importOriginal<typeof EventBatchModule>()
  return {
    ...original,
    queueWatcherEvents(batch: WatcherEventBatchState, events: WatcherEvent[]): void {
      queuedEventCounts.push(events.length)
      original.queueWatcherEvents(batch, events)
    }
  }
})

import { createWslWatcher, type WatchedRoot } from './filesystem-watcher-wsl'
import { MAX_BATCHED_WATCHER_EVENTS } from './filesystem-watcher-event-batch'
import { resetWatcherChildRegistryForTest } from '../watcher-process/parcel-watcher-child-registry'

const ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
type SnapshotEntry = [type: string, mtime: string, path: string]

class SnapshotChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => {
    this.emit('close', null, 'SIGTERM')
    return true
  })
}

function entries(count: number, mtime: string, type = 'f'): SnapshotEntry[] {
  return Array.from({ length: count }, (_, index) => [
    type,
    mtime,
    `/home/me/repo/file-${index}.ts`
  ])
}

function writeSnapshot(child: SnapshotChild, snapshot: SnapshotEntry[]): void {
  child.stdout.write(
    `\0\x1e\0${snapshot.map(([type, mtime, filePath]) => `${type}\t${mtime}\t${filePath}\0`).join('')}\0\x1f\0`
  )
}

async function start(snapshot: SnapshotEntry[]): Promise<{
  child: SnapshotChild
  root: WatchedRoot
  scheduleBatchFlush: ReturnType<typeof vi.fn>
}> {
  const child = new SnapshotChild()
  spawnMock.mockReturnValueOnce(child)
  const scheduleBatchFlush = vi.fn()
  const opening = createWslWatcher(ROOT, ROOT, {
    ignoreDirs: [],
    watchedRoots: new Map(),
    scheduleBatchFlush
  })
  writeSnapshot(child, snapshot)
  return { child, root: await opening, scheduleBatchFlush }
}

describe('WSL snapshot diff admission', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    queuedEventCounts.length = 0
    resetWatcherChildRegistryForTest()
  })

  it.each([2_500, 25_000])('bounds a %i-file update diff before batch admission', async (count) => {
    const { child, root, scheduleBatchFlush } = await start(entries(count, '1'))
    try {
      writeSnapshot(child, entries(count, '2'))

      expect(queuedEventCounts).toEqual([Math.min(count, MAX_BATCHED_WATCHER_EVENTS + 1)])
      expect(scheduleBatchFlush).toHaveBeenCalledOnce()
      expect(root.batch.overflowed).toBe(count > MAX_BATCHED_WATCHER_EVENTS)
      expect(root.batch.events).toHaveLength(count > MAX_BATCHED_WATCHER_EVENTS ? 0 : count)
    } finally {
      await root.subscription.unsubscribe()
    }
  })

  it('uses the remaining capacity of an already populated batch', async () => {
    const { child, root } = await start(entries(25_000, '1'))
    try {
      writeSnapshot(
        child,
        entries(25_000, '1').map(([type, mtime, filePath], index) => [
          type,
          index < 1_000 ? '2' : mtime,
          filePath
        ])
      )
      expect(root.batch.events).toHaveLength(1_000)

      writeSnapshot(child, entries(25_000, '3'))

      expect(queuedEventCounts).toEqual([1_000, MAX_BATCHED_WATCHER_EVENTS - 1_000 + 1])
      expect(root.batch.overflowed).toBe(true)
      expect(root.batch.events).toEqual([])
    } finally {
      await root.subscription.unsubscribe()
    }
  })

  it('bounds type replacements while retaining their delete/create ordering', async () => {
    const { child, root } = await start(entries(25_000, '1'))
    try {
      writeSnapshot(child, entries(25_000, '1', 'd'))

      expect(queuedEventCounts).toEqual([MAX_BATCHED_WATCHER_EVENTS + 2])
      expect(root.batch.overflowed).toBe(true)
      root.batch.overflowed = false
      writeSnapshot(child, entries(25_000, '1', 'd'))
      expect(root.batch.events).toEqual([])

      const next = entries(25_000, '1', 'd')
      next[0] = ['f', '2', '/home/me/repo/file-0.ts']
      writeSnapshot(child, next)

      expect(root.batch.events).toEqual([
        { type: 'delete', path: `${ROOT}\\file-0.ts` },
        { type: 'create', path: `${ROOT}\\file-0.ts` }
      ])
    } finally {
      await root.subscription.unsubscribe()
    }
  })

  it('advances the complete snapshot during pending overflow and resumes precise events', async () => {
    const { child, root, scheduleBatchFlush } = await start(entries(25_000, '1'))
    try {
      writeSnapshot(child, entries(25_000, '2'))
      expect(root.batch.overflowed).toBe(true)
      queuedEventCounts.length = 0
      scheduleBatchFlush.mockClear()

      const latest = entries(25_000, '3').filter(
        ([, , filePath]) => !filePath.endsWith('/file-24999.ts')
      )
      latest.push(['f', '3', '/home/me/repo/created-while-overflow.ts'])
      writeSnapshot(child, latest)

      expect(queuedEventCounts).toEqual([])
      expect(scheduleBatchFlush).not.toHaveBeenCalled()
      expect(root.batch.events).toEqual([])
      root.batch.overflowed = false

      const recovered = latest.filter(([, , filePath]) => !filePath.endsWith('/file-1.ts'))
      recovered[0] = ['f', '4', '/home/me/repo/file-0.ts']
      recovered.push(['f', '4', '/home/me/repo/created-after-overflow.ts'])
      writeSnapshot(child, recovered)

      expect(queuedEventCounts).toEqual([3])
      expect(root.batch.overflowed).toBe(false)
      expect(root.batch.events).toEqual([
        { type: 'update', path: `${ROOT}\\file-0.ts` },
        { type: 'create', path: `${ROOT}\\created-after-overflow.ts` },
        { type: 'delete', path: `${ROOT}\\file-1.ts` }
      ])
    } finally {
      await root.subscription.unsubscribe()
    }
  })
})
