import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'
import { buildMobileDiffReviewQueue } from './mobile-diff-review-queue'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { ReviewDiffState, ReviewScreenState } from './mobile-diff-review-screen-model'
import { useMobileDiffReviewDiffLoading } from './use-mobile-diff-review-diff-loading'
import * as diffLines from './mobile-diff-lines'
import * as syntax from './mobile-file-syntax'
import * as hunks from './mobile-diff-hunks'
import { loadMobileDiffReviewDiff } from './mobile-diff-review-loaders'

const settings = vi.hoisted(() => ({ diffShowWhitespace: false }))
vi.mock('../source-control/mobile-source-control-settings', () => ({
  useMobileSourceControlSettings: () => ({ settings })
}))
const buildDiff = vi.spyOn(diffLines, 'buildMobileDiffLines')
const highlight = vi.spyOn(syntax, 'highlightMobileDiffLines')
const buildHunks = vi.spyOn(hunks, 'buildMobileDiffHunks')
const items = buildMobileDiffReviewQueue({
  worktreeId: 'folder:repo',
  statusEntries: [
    { path: 'old.ts', status: 'modified', area: 'unstaged' },
    { path: 'live.ts', status: 'modified', area: 'unstaged' }
  ],
  branchEntries: [],
  comments: [],
  reviewState: { version: 1, files: {} }
})
const readyScreen: ReviewScreenState = {
  kind: 'ready',
  branchCompare: null,
  status: {
    entries: [],
    conflictOperation: undefined,
    branch: undefined,
    head: undefined,
    upstreamStatus: undefined
  },
  comments: [],
  reviewState: { version: 1, files: {} }
}
const state: { current: ReviewDiffState } = { current: { kind: 'idle' } }
const hunk: { current: number | null; select: ((index: number | null) => void) | null } = {
  current: null,
  select: null
}
const replies: ((response: RpcResponse) => void)[] = []
const methods: string[] = []
const client = stubRpcClient({
  sendRequest: (method) => {
    methods.push(method)
    return new Promise((resolve) => replies.push(resolve))
  }
})
let renderer: ReactTestRenderer | null = null
function Probe({ item }: { item: MobileDiffReviewQueueItem }): null {
  const [activeHunkIndex, setActiveHunkIndex] = useState<number | null>(null)
  hunk.current = activeHunkIndex
  hunk.select = setActiveHunkIndex
  state.current = useMobileDiffReviewDiffLoading({
    client,
    connState: 'connected',
    worktreeId: 'folder:repo',
    currentItem: item,
    screenState: readyScreen,
    setActiveHunkIndex
  })
  return null
}
function reply(originalContent: string, modifiedContent: string): RpcResponse {
  return { id: 'diff', ok: true, result: { kind: 'text', originalContent, modifiedContent } }
}
async function settle(index: number, response: RpcResponse): Promise<void> {
  await act(async () => {
    replies[index]?.(response)
  })
}
beforeEach(() => {
  settings.diffShowWhitespace = false
  buildDiff.mockClear()
  highlight.mockClear()
  buildHunks.mockClear()
  replies.length = 0
  methods.length = 0
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

it('retires a committed review after its RPC while live branch render modes still load', async () => {
  const item = { ...items[0]!, scope: 'branch' as const }
  const branchCompare = {
    summary: {
      baseRef: 'main',
      headOid: 'head',
      mergeBase: 'base',
      status: 'ready' as const,
      changedFiles: 1
    },
    entries: []
  }
  const controller = new AbortController()
  const retired = loadMobileDiffReviewDiff({
    client,
    worktreeId: 'folder:repo',
    item,
    branchCompare,
    signal: controller.signal
  })
  expect(methods).toEqual(['git.branchDiff'])
  controller.abort()
  replies[0]?.(reply('old', 'new'))
  const result = await retired
  const discardedBuilds = buildDiff.mock.calls.length
  const current = loadMobileDiffReviewDiff({
    client,
    worktreeId: 'folder:repo',
    item,
    branchCompare
  })
  replies[1]?.({ id: 'binary', ok: true, result: { kind: 'binary' } })
  await expect(current).resolves.toEqual({ kind: 'binary', itemKey: item.key })
  expect(result).toEqual({ kind: 'idle' })
  expect(discardedBuilds).toBe(0)
  expect(highlight).not.toHaveBeenCalled()
  expect(buildHunks).not.toHaveBeenCalled()
})

it.each([100, 1000])(
  'skips a retired %i-line review while the replacement still projects',
  async (count) => {
    act(() => {
      renderer = create(createElement(Probe, { item: items[0]! }))
    })
    act(() => hunk.select?.(0))
    act(() => renderer?.update(createElement(Probe, { item: items[1]! })))
    expect(hunk.current).toBeNull()
    const original = Array.from({ length: count }, (_, index) => `const value${index} = 1`).join(
      '\n'
    )
    await settle(0, reply(original, original.replaceAll('= 1', '= 2')))
    expect(state.current).toMatchObject({ kind: 'loading', itemKey: items[1]!.key })
    const discardedInputs = buildDiff.mock.calls.reduce(
      (total, [before, after]) => total + before.length + after.length,
      0
    )
    const discardedHighlights = highlight.mock.calls.length
    const discardedHunks = buildHunks.mock.calls.length
    await settle(1, reply('const value = 1\n', ' const value = 1 \nconst next = 2\n'))
    expect(state.current).toMatchObject({
      kind: 'ready',
      itemKey: items[1]!.key,
      truncated: false,
      lines: [
        { kind: 'context', text: ' const value = 1 ', highlighted: true },
        { kind: 'add', text: 'const next = 2', highlighted: true }
      ],
      hunks: [{ index: 0, addedLines: 1, deletedLines: 0, firstLineNumber: 2 }]
    })
    expect(methods).toEqual(['git.diff', 'git.diff'])
    expect(buildDiff.mock.calls.at(-1)?.[2]).toEqual({ ignoreTrimWhitespace: true })
    expect(discardedInputs).toBe(0)
    expect(discardedHighlights).toBe(0)
    expect(discardedHunks).toBe(0)
    expect(buildDiff).toHaveBeenCalledTimes(1)
  }
)

it('retires unmounted work and still honors whitespace changes on a fresh owner', async () => {
  act(() => {
    renderer = create(createElement(Probe, { item: items[0]! }))
  })
  act(() => renderer?.unmount())
  renderer = null
  await settle(0, reply('old\n', 'new\n'))
  const retiredBuilds = buildDiff.mock.calls.length
  act(() => {
    renderer = create(createElement(Probe, { item: items[1]! }))
  })
  await settle(1, reply('const value = 1\n', ' const value = 1 \n'))
  expect(state.current).toMatchObject({ kind: 'ready', lines: [{ kind: 'context' }], hunks: [] })
  act(() => hunk.select?.(0))
  settings.diffShowWhitespace = true
  act(() => renderer?.update(createElement(Probe, { item: items[1]! })))
  await settle(2, reply('const value = 1\n', ' const value = 1 \n'))
  expect(state.current).toMatchObject({
    kind: 'ready',
    lines: [{ kind: 'delete' }, { kind: 'add' }],
    hunks: [{ addedLines: 1, deletedLines: 1 }]
  })
  expect(hunk.current).toBe(0)
  expect(buildDiff.mock.calls.at(-1)?.[2]).toEqual({ ignoreTrimWhitespace: false })
  expect(retiredBuilds).toBe(0)
  expect(buildDiff).toHaveBeenCalledTimes(2)
})
