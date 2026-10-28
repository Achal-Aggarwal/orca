// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import {
  MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS,
  requestSharedMarkdownDocumentList
} from './markdown-document-list-request'
import {
  getLatestMarkdownMembershipChangeAt,
  useMarkdownDocumentWatchRefresh
} from './use-markdown-document-watch-refresh'

const refresh = async (): Promise<void> => {}
const change = (rootPath: string): void => {
  window.dispatchEvent(
    new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
      detail: {
        runtimeEnvironmentId: null,
        payload: {
          worktreePath: rootPath,
          events: [{ kind: 'create', absolutePath: `${rootPath}/note.md` }]
        }
      }
    })
  )
}

function watch(rootPath: string) {
  return renderHook(
    ({ path }) =>
      useMarkdownDocumentWatchRefresh({
        enabled: true,
        worktreePath: path,
        runtimeEnvironmentId: null,
        refresh
      }),
    { initialProps: { path: rootPath } }
  )
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function pendingScan(rootPath: string) {
  const context: RuntimeFileOperationArgs = {
    target: { kind: 'local' },
    worktreeId: rootPath,
    worktreePath: rootPath
  }
  let settle = (): void => {}
  const pending = new Promise<MarkdownDocument[]>((resolve) => {
    settle = () => resolve([])
  })
  const load = vi.fn(() => pending)
  const request = () =>
    requestSharedMarkdownDocumentList(
      context,
      rootPath,
      {
        freshAfter: getLatestMarkdownMembershipChangeAt(null, rootPath)
      },
      load
    )
  return { load, request, settle }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(async () => {
  cleanup()
  await advance(MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS)
  vi.useRealTimers()
})

it('releases stamps for 100 retired watched roots after their request join window', async () => {
  const paths = Array.from({ length: 100 }, (_, index) => `/repo/retired-${index}`)
  const hook = watch(paths[0])
  for (const path of paths) {
    hook.rerender({ path })
    change(path)
  }
  hook.unmount()
  expect(
    paths.filter((path) => getLatestMarkdownMembershipChangeAt(null, path) !== undefined)
  ).toHaveLength(100)
  expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
  await advance(MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS)
  expect(
    paths.filter((path) => getLatestMarkdownMembershipChangeAt(null, path) !== undefined)
  ).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves the stamp when a pane remounts before an older scan stops being joinable', async () => {
  const path = '/repo/remount'
  const scan = pendingScan(path)
  const initial = scan.request()
  const hook = watch(path)
  await advance(10)
  change(path)
  hook.unmount()
  await advance(10)
  expect(getLatestMarkdownMembershipChangeAt(null, path)).toBe(10)
  const afterRemount = scan.request()
  expect(afterRemount).not.toBe(initial)
  expect(scan.load).toHaveBeenCalledTimes(2)
  scan.settle()
  await Promise.all([initial, afterRemount])
})

it('cannot rejoin a pre-change scan after the protecting stamp expires', async () => {
  const path = '/repo/expired'
  const scan = pendingScan(path)
  const initial = scan.request()
  const hook = watch(path)
  await advance(10)
  change(path)
  hook.unmount()
  await advance(MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS)
  expect(getLatestMarkdownMembershipChangeAt(null, path)).toBeUndefined()
  const afterExpiry = scan.request()
  expect(afterExpiry).not.toBe(initial)
  expect(scan.load).toHaveBeenCalledTimes(2)
  scan.settle()
  await Promise.all([initial, afterExpiry])
})

it('extends a changed root through its newest join window with one cleanup timer', async () => {
  const path = '/repo/updated'
  const hook = watch(path)
  change(path)
  await advance(MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS - 1)
  change(path)
  const latest = performance.now()
  hook.unmount()
  await advance(1)
  expect(getLatestMarkdownMembershipChangeAt(null, path)).toBe(latest)
  expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
  await advance(MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS - 1)
  expect(getLatestMarkdownMembershipChangeAt(null, path)).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})
