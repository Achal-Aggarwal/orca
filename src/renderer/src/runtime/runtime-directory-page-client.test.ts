import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY } from '../../../shared/files-runtime-capabilities'

const callRuntimeRpc = vi.fn()
const readRuntimeDirectory = vi.fn()
let statuses = new Map<string, unknown>()

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
vi.mock('./runtime-file-mutation-client', () => ({
  readRuntimeDirectory: (...args: unknown[]) => readRuntimeDirectory(...args)
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ runtimeStatusByEnvironmentId: statuses }) }
}))

import {
  readRuntimeDirectoryPage,
  runtimeDirectoryPagesSupported
} from './runtime-directory-page-client'

const REMOTE = {
  target: { kind: 'environment' as const, environmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/srv/repo'
}
const entry = (name: string) => ({ name, isDirectory: false, isSymlink: false })

function hostWithCapabilities(capabilities: string[]): void {
  statuses = new Map([['env-1', { status: { capabilities } }]])
}

describe('readRuntimeDirectoryPage', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
    readRuntimeDirectory.mockReset()
    statuses = new Map()
  })

  it('asks a host that pages for one page and returns its total', async () => {
    hostWithCapabilities([FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY])
    callRuntimeRpc.mockResolvedValueOnce({ entries: [entry('b')], total: 3 })

    await expect(
      readRuntimeDirectoryPage(REMOTE, '/srv/repo/big', { offset: 1, limit: 1 })
    ).resolves.toEqual({ entries: [entry('b')], total: 3 })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      REMOTE.target,
      'files.readDir',
      { worktree: 'id:wt-1', relativePath: 'big', offset: 1, limit: 1 },
      { timeoutMs: 15_000 }
    )
    expect(readRuntimeDirectory).not.toHaveBeenCalled()
  })

  it('sends an older host the unpaged request it already understands', async () => {
    hostWithCapabilities([])
    readRuntimeDirectory.mockResolvedValueOnce([entry('a'), entry('b')])

    await expect(
      readRuntimeDirectoryPage(REMOTE, '/srv/repo/big', { offset: 0, limit: 1 })
    ).resolves.toEqual({ entries: [entry('a'), entry('b')], total: 2 })
    expect(readRuntimeDirectory).toHaveBeenCalledWith(REMOTE, '/srv/repo/big', {})
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('takes the whole folder from a host that ignored the page fields', async () => {
    hostWithCapabilities([FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY])
    callRuntimeRpc.mockResolvedValueOnce([entry('a'), entry('b'), entry('c')])

    await expect(
      readRuntimeDirectoryPage(REMOTE, '/srv/repo/big', { offset: 1, limit: 1 })
    ).resolves.toEqual({ entries: [entry('b'), entry('c')], total: 3 })
  })

  it('never pages a local folder', async () => {
    readRuntimeDirectory.mockResolvedValueOnce([entry('a')])
    const local = { target: { kind: 'local' as const }, worktreeId: 'wt-1', worktreePath: '/w' }

    await expect(
      readRuntimeDirectoryPage(local, '/w', { offset: 0, limit: 1 }, { wakeWslDistro: true })
    ).resolves.toEqual({ entries: [entry('a')], total: 1 })
    expect(readRuntimeDirectory).toHaveBeenCalledWith(local, '/w', { wakeWslDistro: true })
  })

  it('reports paging only for a remote folder whose host advertises it', () => {
    expect(runtimeDirectoryPagesSupported(REMOTE, '/srv/repo/big')).toBe(false)
    hostWithCapabilities([FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY])
    expect(runtimeDirectoryPagesSupported(REMOTE, '/srv/repo/big')).toBe(true)
    const local = { target: { kind: 'local' as const }, worktreeId: 'wt-1', worktreePath: '/w' }
    expect(runtimeDirectoryPagesSupported(local, '/w')).toBe(false)
  })
})
