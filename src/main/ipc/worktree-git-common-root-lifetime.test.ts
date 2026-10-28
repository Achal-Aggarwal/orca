import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribeViaWatcherProcess } from './filesystem/watcher-process/parcel-watcher-process'
import { WatcherProcessFailure } from './filesystem/watcher-process/parcel-watcher-process-failure'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks
} from './filesystem/watcher-process/parcel-watcher-process-subscription'
import { startGitCommonNarrowWatch } from './worktree-git-common-narrow-watch'
import { startGitCommonPolling } from './worktree-git-common-polling'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription
} from './worktree-base-directory-poller'

type RootFilesystemControl = {
  root: string
  stat: (() => Promise<void>) | null
  read: (() => Promise<void>) | null
  reads: number
  upgrade: () => Promise<void>
}
const fsControl = vi.hoisted<RootFilesystemControl>(() => ({
  root: '',
  stat: null,
  read: null,
  reads: 0,
  upgrade: async () => {}
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (args[0] === fsControl.root) {
        await fsControl.stat?.()
      }
      return actual.stat(...args)
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (args[0] === fsControl.root) {
        fsControl.reads++
        await fsControl.read?.()
      }
      return actual.readdir(...args)
    }
  }
})
vi.mock('./filesystem/watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: vi.fn()
}))
// Drive the production upgrade directly without advancing five minutes of fallback polling.
vi.mock('./worktree-git-common-native-upgrade-poll', () => ({
  createNativeUpgradePoll: (attempt: () => Promise<void>) => {
    fsControl.upgrade = attempt
    return { arm: () => {}, stop: () => {} }
  }
}))

const POLL_MS = 10
const RECONCILE_MS = POLL_MS * 15
const visible = { isWindowVisible: () => true, onWindowBecameVisible: () => () => {} }
const native = vi.mocked(subscribeViaWatcherProcess)
const subscriptions: {
  callback: WatcherProcessCallback
  hooks: WatcherProcessHooks
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>
}[] = []
const cleanups: (() => Promise<void>)[] = []
let common: string
const installNative: typeof subscribeViaWatcherProcess = async (
  _path,
  callback,
  _options,
  hooks = {}
) => {
  const unsubscribe = vi.fn(async () => {})
  subscriptions.push({ callback, hooks, unsubscribe })
  return { unsubscribe }
}

beforeEach(async () => {
  common = await realpath(await mkdtemp(join(tmpdir(), 'orca-root-lifetime-')))
  fsControl.root = join(common, 'worktrees')
  fsControl.stat = null
  fsControl.read = null
  fsControl.reads = 0
  await recreate()
  native.mockReset()
  native.mockImplementation(installNative)
  vi.useFakeTimers()
})

afterEach(async () => {
  fsControl.stat = null
  fsControl.read = null
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(common, { recursive: true, force: true })
  subscriptions.length = 0
  vi.useRealTimers()
})

async function recreate(): Promise<void> {
  await mkdir(join(fsControl.root, 'same-child'), { recursive: true })
}

function start(events: WorktreeBasePollEvent[][], errors = vi.fn(), overflow = vi.fn()) {
  return startGitCommonNarrowWatch(
    { key: 'root-lifetime', kind: 'git-common', path: common, repos: new Map() },
    (batch) => events.push(batch),
    POLL_MS,
    'darwin',
    visible,
    undefined,
    errors,
    overflow
  )
}

function lateDelivery(index: number): void {
  const old = subscriptions[index]
  old.callback(null, [{ type: 'update', path: join(fsControl.root, 'stale') }])
  old.hooks.onInterruption?.()
  old.hooks.onOverflow?.()
}

it('fences a pending native subscribe when root deletion and creation are separate snapshots', async () => {
  const pending = Promise.withResolvers<WorktreeBaseSubscription>()
  native.mockImplementation(async (...args) => {
    const subscription = await installNative(...args)
    return subscriptions.length === 2 ? pending.promise : subscription
  })
  const events: WorktreeBasePollEvent[][] = []
  const errors = vi.fn()
  const overflow = vi.fn()
  const watch = await start(events, errors, overflow)
  cleanups.push(() => watch.unsubscribe())
  try {
    subscriptions[0].callback(null, [{ type: 'delete', path: fsControl.root }])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2))
    events.length = 0
    fsControl.stat = async () => {
      fsControl.stat = null
      await rm(fsControl.root, { recursive: true })
    }
    fsControl.read = async () => {
      fsControl.read = null
      await recreate()
    }
    await vi.advanceTimersByTimeAsync(RECONCILE_MS)
    await vi.waitFor(() =>
      expect(events.flat()).toContainEqual({ type: 'delete', path: fsControl.root })
    )
    expect(events.flat()).not.toContainEqual({ type: 'create', path: fsControl.root })
    const before = events.length
    lateDelivery(1)
    expect(events).toHaveLength(before)
    expect(errors).not.toHaveBeenCalled()
    expect(overflow).not.toHaveBeenCalled()
    pending.resolve({ unsubscribe: subscriptions[1].unsubscribe })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(subscriptions).toHaveLength(3))
    expect(subscriptions[1].unsubscribe).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(RECONCILE_MS)
    await vi.waitFor(() =>
      expect(events.flat()).toContainEqual({ type: 'create', path: fsControl.root })
    )
    subscriptions[2].callback(null, [{ type: 'update', path: join(fsControl.root, 'fresh') }])
    expect(events.flat()).toContainEqual({ type: 'update', path: join(fsControl.root, 'fresh') })
  } finally {
    pending.resolve({ unsubscribe: subscriptions[1].unsubscribe })
  }
})

it.each([
  ['startup', 'ENOENT'],
  ['upgrade', 'ENOENT'],
  ['startup', 'ENOTDIR'],
  ['upgrade', 'ENOTDIR'],
  ['startup', 'EIO'],
  ['upgrade', 'EIO']
] as const)('handles %s baseline root observation %s before recreation', async (entry, code) => {
  const absent = code === 'ENOENT' || code === 'ENOTDIR'
  const blocked = Promise.withResolvers<void>()
  const reachedRead = vi.fn()
  native.mockImplementation(async (...args) => {
    if (entry === 'upgrade' && native.mock.calls.length === 1) {
      throw new WatcherProcessFailure('test fuse', 'supervisor', 'supervisor_crash_fuse')
    }
    const subscription = await installNative(...args)
    if (subscriptions.length === 1) {
      if (absent) {
        await rm(fsControl.root, { recursive: true })
      }
      fsControl.stat = async () => {
        fsControl.stat = null
        throw Object.assign(new Error('controlled root stat'), { code })
      }
      fsControl.read = async () => {
        reachedRead()
        await blocked.promise
      }
    }
    return subscription
  })
  const events: WorktreeBasePollEvent[][] = []
  const errors = vi.fn()
  const overflow = vi.fn()
  const starting = start(events, errors, overflow)
  let upgrading: Promise<void> | undefined
  try {
    if (entry === 'upgrade') {
      await starting
      upgrading = fsControl.upgrade()
    }
    await vi.waitFor(() => expect(reachedRead).toHaveBeenCalled())
    const before = events.length
    lateDelivery(0)
    if (absent) {
      expect(events).toHaveLength(before)
      expect(errors).not.toHaveBeenCalled()
      expect(overflow).not.toHaveBeenCalled()
      expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
    } else {
      expect(subscriptions[0].unsubscribe).not.toHaveBeenCalled()
      expect(errors).toHaveBeenCalledOnce()
      expect(overflow).toHaveBeenCalledOnce()
      expect(events).toHaveLength(before + 1)
    }
    await recreate()
    blocked.resolve()
    fsControl.read = null
    await starting
    await upgrading
    await vi.advanceTimersByTimeAsync(POLL_MS)
    if (absent) {
      await vi.waitFor(() => expect(subscriptions).toHaveLength(2))
    }
    const current = subscriptions[absent ? 1 : 0]
    current.callback(null, [{ type: 'update', path: join(fsControl.root, 'fresh') }])
    expect(events.flat()).toContainEqual({ type: 'update', path: join(fsControl.root, 'fresh') })
    if (absent) {
      expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
    }
  } finally {
    await recreate()
    blocked.resolve()
    fsControl.read = null
    await upgrading
    await (await starting).unsubscribe()
  }
})

it('converges when a delayed deletion snapshot retires an already fresh subscription', async () => {
  const events: WorktreeBasePollEvent[][] = []
  const errors = vi.fn()
  const overflow = vi.fn()
  const watch = await start(events, errors, overflow)
  cleanups.push(() => watch.unsubscribe())
  const blocked = Promise.withResolvers<void>()
  const reachedRead = vi.fn()
  fsControl.stat = async () => {
    fsControl.stat = null
    await rm(fsControl.root, { recursive: true })
  }
  fsControl.read = async () => {
    reachedRead()
    await blocked.promise
  }
  try {
    await vi.advanceTimersByTimeAsync(RECONCILE_MS)
    await vi.waitFor(() => expect(reachedRead).toHaveBeenCalled())
    subscriptions[0].callback(null, [{ type: 'delete', path: fsControl.root }])
    await recreate()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2))
    blocked.resolve()
    fsControl.read = null
    await vi.waitFor(() => expect(subscriptions[1].unsubscribe).toHaveBeenCalledOnce())
    const before = events.length
    lateDelivery(1)
    expect(events).toHaveLength(before)
    expect(errors).not.toHaveBeenCalled()
    expect(overflow).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(subscriptions).toHaveLength(3))
    const reads = fsControl.reads
    await vi.advanceTimersByTimeAsync(RECONCILE_MS * 3)
    await vi.waitFor(() => expect(fsControl.reads).toBeGreaterThan(reads))
    expect(subscriptions).toHaveLength(3)
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
    expect(subscriptions[1].unsubscribe).toHaveBeenCalledOnce()
    subscriptions[2].callback(null, [{ type: 'update', path: join(fsControl.root, 'fresh') }])
    expect(events.flat()).toContainEqual({ type: 'update', path: join(fsControl.root, 'fresh') })
  } finally {
    blocked.resolve()
  }
})

it.each(['EACCES', 'EIO', undefined, 'ENOENT', 'ENOTDIR'])(
  'preserves root evidence on stat error %s',
  async (code) => {
    const events: WorktreeBasePollEvent[][] = []
    const scanned = vi.fn()
    const watch = await startGitCommonPolling(
      common,
      (batch) => events.push(batch),
      POLL_MS,
      visible,
      scanned,
      false,
      () => [],
      { reconciliationFullScanEveryTicks: 1 }
    )
    cleanups.push(() => watch.unsubscribe())
    const absent = code === 'ENOENT' || code === 'ENOTDIR'
    fsControl.stat = async () => {
      throw Object.assign(new Error('controlled root stat'), { code })
    }
    const reads = fsControl.reads
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(fsControl.reads).toBeGreaterThan(reads))
    await vi.waitFor(() => expect(scanned).toHaveBeenCalled())
    expect(
      events.flat().some((event) => event.type === 'delete' && event.path === fsControl.root)
    ).toBe(absent)
    fsControl.stat = null
    const afterError = join(fsControl.root, 'after-error')
    await mkdir(afterError)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() =>
      expect(events.flat()).toContainEqual({ type: 'create', path: afterError })
    )
  }
)

it('keeps an ordinary polling baseline silent when the root is absent', async () => {
  await rm(fsControl.root, { recursive: true })
  const events = vi.fn()
  const watch = await startGitCommonPolling(common, events, POLL_MS, visible)
  cleanups.push(() => watch.unsubscribe())
  expect(events).not.toHaveBeenCalled()
})
