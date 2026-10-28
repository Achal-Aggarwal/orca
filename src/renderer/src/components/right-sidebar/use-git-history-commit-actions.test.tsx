// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { GitCommitCompareResult } from '../../../../shared/git-diff-compare-types'
import type { GitHistoryItem, GitHistoryResult } from '../../../../shared/git-history'
import type { GitHistoryPanelState } from './source-control/sync/git-history-panel'
import { deferred, mountProbe, unmountProbes } from './source-control-hook-test-harness'

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  openAll: vi.fn(),
  openFile: vi.fn(),
  error: vi.fn(),
  connectionId: vi.fn<() => string | undefined>()
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ openCommitAllDiffs: mocks.openAll, openCommitDiff: mocks.openFile })
}))
vi.mock('@/runtime/runtime-git-diff-client', () => ({ getRuntimeGitCommitCompare: mocks.compare }))
vi.mock('@/runtime/runtime-git-working-tree-client', () => ({
  getRuntimeGitRemoteCommitUrl: vi.fn()
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: mocks.connectionId }))
vi.mock('@/lib/language-detect', () => ({ detectLanguage: () => 'plaintext' }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: vi.fn() }))
vi.mock('@/lib/agent-launch-request-id', () => ({ newAgentLaunchRequestId: vi.fn() }))
vi.mock('@/lib/agent-tab-shortcuts', () => ({ resolveDefaultAgentForWorktreeNewTab: vi.fn() }))
vi.mock('@/lib/agent-detection-target-inventory', () => ({
  getDetectionTargetIdentityForWorktree: vi.fn()
}))
vi.mock('@/lib/workspace-browser-tab-open', () => ({ openWorkspaceBrowserTab: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.error, success: vi.fn() } }))

import { useGitHistoryCommitActions } from './source-control/sync/use-git-history-commit-actions'

type Actions = ReturnType<typeof useGitHistoryCommitActions>
type Owner = {
  worktreeId: string
  path: string
  target: RuntimeClientTarget
}
const OWNER: Owner = { worktreeId: 'one', path: '/repo', target: { kind: 'local' } }
const COMMIT: GitHistoryItem = {
  id: 'a'.repeat(40),
  parentIds: ['b'.repeat(40)],
  subject: 'Update tracked file',
  message: 'Update tracked file'
}
const HISTORY: GitHistoryResult = {
  items: [COMMIT],
  hasIncomingChanges: false,
  hasOutgoingChanges: false,
  hasMore: false,
  limit: 50
}
const READY_HISTORY_STATE: GitHistoryPanelState = { status: 'ready', result: HISTORY }
const COMPARE: GitCommitCompareResult = {
  summary: {
    commitOid: COMMIT.id,
    parentOid: COMMIT.parentIds[0],
    compareRef: 'aaaaaaa',
    baseRef: 'bbbbbbb',
    changedFiles: 1,
    status: 'ready'
  },
  entries: [{ path: 'changed.txt', status: 'modified' }]
}
// The same commit at a shallow boundary compares against the empty tree.
const SHALLOW_COMPARE: GitCommitCompareResult = {
  summary: { ...COMPARE.summary, parentOid: null, baseRef: 'empty tree', changedFiles: 2 },
  entries: [
    { path: 'changed.txt', status: 'added' },
    { path: 'unchanged.txt', status: 'added' }
  ]
}
let latest: Actions
const splitTarget = () => undefined

function Probe({
  owner,
  historyState = READY_HISTORY_STATE
}: {
  owner: Owner
  historyState?: GitHistoryPanelState
}): null {
  latest = useGitHistoryCommitActions({
    activeWorktreeId: owner.worktreeId,
    worktreePath: owner.path,
    activeRepoTarget: owner.target,
    historyResult: historyState.result,
    resolveSplitTargetGroupId: splitTarget
  })
  return null
}

beforeEach(() => {
  mocks.compare.mockReset().mockResolvedValue(COMPARE)
  mocks.connectionId.mockReset()
})
afterEach(() => {
  unmountProbes()
  vi.clearAllMocks()
})

describe('Git history comparison owner', () => {
  it.each([
    { ...OWNER, path: '/shallow-clone' },
    { ...OWNER, target: { kind: 'environment', environmentId: 'shallow-host' } }
  ] satisfies Owner[])(
    'does not reuse another owner comparison for the same commit: %j',
    async (successor) => {
      const root = await mountProbe(<Probe owner={OWNER} />)
      expect(await latest.loadCommitFiles(COMMIT)).toEqual(COMPARE.entries)
      mocks.compare.mockResolvedValue(SHALLOW_COMPARE)
      await act(async () => root.render(<Probe owner={successor} />))

      expect(await latest.loadCommitFiles(COMMIT)).toEqual(SHALLOW_COMPARE.entries)
      latest.openCommitFile(COMMIT, SHALLOW_COMPARE.entries[1])
      expect(mocks.openFile).toHaveBeenCalledWith(
        successor.worktreeId,
        successor.path,
        SHALLOW_COMPARE.entries[1],
        expect.objectContaining({ parentOid: null }),
        'plaintext',
        expect.any(Object)
      )
    }
  )

  it('does not reuse a prior local connection comparison', async () => {
    mocks.connectionId.mockReturnValue('first-connection')
    const root = await mountProbe(<Probe owner={OWNER} />)
    await latest.loadCommitFiles(COMMIT)
    mocks.connectionId.mockReturnValue('second-connection')
    mocks.compare.mockResolvedValue(SHALLOW_COMPARE)
    await act(async () => root.render(<Probe owner={OWNER} />))

    expect(await latest.loadCommitFiles(COMMIT)).toEqual(SHALLOW_COMPARE.entries)
  })

  it('prevents an old worktree reply from overwriting the current comparison', async () => {
    const old = deferred<GitCommitCompareResult>()
    mocks.compare.mockReturnValueOnce(old.promise).mockResolvedValue(SHALLOW_COMPARE)
    const root = await mountProbe(<Probe owner={OWNER} />)
    const oldRequest = latest.loadCommitFiles(COMMIT)
    const successor = { ...OWNER, worktreeId: 'two', path: '/shallow-clone' }
    await act(async () => root.render(<Probe owner={successor} />))
    expect(await latest.loadCommitFiles(COMMIT)).toEqual(SHALLOW_COMPARE.entries)
    old.resolve(COMPARE)
    await oldRequest

    expect(await latest.loadCommitFiles(COMMIT)).toEqual(SHALLOW_COMPARE.entries)
  })

  it.each(['switch', 'unmount'] as const)(
    'does not open a diff after its owner retires by %s',
    async (retirement) => {
      const old = deferred<GitCommitCompareResult>()
      mocks.compare.mockReturnValueOnce(old.promise)
      const root = await mountProbe(<Probe owner={OWNER} />)
      const pendingOpen = latest.openHistoryCommitDiff(COMMIT)
      if (retirement === 'switch') {
        await act(async () => root.render(<Probe owner={{ ...OWNER, worktreeId: 'two' }} />))
      } else {
        unmountProbes()
      }
      old.resolve(COMPARE)
      await pendingOpen

      expect(mocks.openAll).not.toHaveBeenCalled()
      expect(mocks.error).not.toHaveBeenCalled()
    }
  )

  it('ignores a retired owner failure', async () => {
    const old = deferred<GitCommitCompareResult>()
    mocks.compare.mockReturnValueOnce(old.promise)
    const root = await mountProbe(<Probe owner={OWNER} />)
    const pendingOpen = latest.openHistoryCommitDiff(COMMIT)
    await act(async () => root.render(<Probe owner={{ ...OWNER, path: '/other-clone' }} />))
    old.reject(new Error('Retired repository disconnected'))
    await pendingOpen

    expect(mocks.error).not.toHaveBeenCalled()
    expect(mocks.openAll).not.toHaveBeenCalled()
  })

  it('reports current owner failures and allows a successful retry', async () => {
    mocks.compare.mockRejectedValueOnce(new Error('Repository disconnected'))
    await mountProbe(<Probe owner={OWNER} />)
    await latest.openHistoryCommitDiff(COMMIT)
    expect(mocks.error).toHaveBeenCalledWith('Repository disconnected')
    expect(mocks.openAll).not.toHaveBeenCalled()

    await latest.openHistoryCommitDiff(COMMIT)
    expect(mocks.compare).toHaveBeenCalledTimes(2)
    expect(mocks.openAll).toHaveBeenCalledTimes(1)
  })

  it('reuses the comparison through expansion and opening with equal rebuilt targets', async () => {
    const owner: Owner = { ...OWNER, target: { kind: 'environment', environmentId: 'host' } }
    const root = await mountProbe(<Probe owner={owner} />)
    expect(await latest.loadCommitFiles(COMMIT)).toEqual(COMPARE.entries)
    await act(async () =>
      root.render(
        <Probe owner={{ ...owner, target: { kind: 'environment', environmentId: 'host' } }} />
      )
    )
    await latest.openHistoryCommitDiff(COMMIT)

    expect(mocks.compare).toHaveBeenCalledTimes(1)
    expect(mocks.openAll).toHaveBeenCalledWith(
      owner.worktreeId,
      owner.path,
      COMPARE.summary,
      COMPARE.entries,
      COMMIT.subject,
      COMMIT.message
    )
  })

  it('reloads a same-commit comparison after a successful history refresh changes ancestry', async () => {
    const root = await mountProbe(<Probe owner={OWNER} />)
    await latest.loadCommitFiles(COMMIT)
    mocks.compare.mockResolvedValue(SHALLOW_COMPARE)
    const refreshed = { ...HISTORY, items: [{ ...COMMIT, parentIds: [] }] }
    await act(async () =>
      root.render(<Probe owner={OWNER} historyState={{ status: 'ready', result: refreshed }} />)
    )

    await latest.openHistoryCommitDiff(refreshed.items[0])
    expect(mocks.compare).toHaveBeenCalledTimes(2)
    expect(mocks.openAll).toHaveBeenCalledWith(
      OWNER.worktreeId,
      OWNER.path,
      SHALLOW_COMPARE.summary,
      SHALLOW_COMPARE.entries,
      COMMIT.subject,
      COMMIT.message
    )
  })

  it('shares comparison data through refreshing and error states retaining the same result', async () => {
    const root = await mountProbe(<Probe owner={OWNER} />)
    await latest.loadCommitFiles(COMMIT)
    await act(async () =>
      root.render(<Probe owner={OWNER} historyState={{ status: 'refreshing', result: HISTORY }} />)
    )
    await latest.loadCommitFiles(COMMIT)
    await act(async () =>
      root.render(
        <Probe
          owner={OWNER}
          historyState={{ status: 'error', result: HISTORY, error: 'History read disconnected' }}
        />
      )
    )
    await latest.openHistoryCommitDiff(COMMIT)

    expect(mocks.compare).toHaveBeenCalledTimes(1)
    expect(mocks.openAll).toHaveBeenCalledTimes(1)
  })

  it('retires pending diff navigation and cache writes when the history page refreshes', async () => {
    const old = deferred<GitCommitCompareResult>()
    mocks.compare.mockReturnValueOnce(old.promise).mockResolvedValue(SHALLOW_COMPARE)
    const root = await mountProbe(<Probe owner={OWNER} />)
    const pendingOpen = latest.openHistoryCommitDiff(COMMIT)
    await act(async () =>
      root.render(
        <Probe owner={OWNER} historyState={{ status: 'ready', result: { ...HISTORY } }} />
      )
    )
    expect(await latest.loadCommitFiles(COMMIT)).toEqual(SHALLOW_COMPARE.entries)
    old.resolve(COMPARE)
    await pendingOpen

    expect(mocks.openAll).not.toHaveBeenCalled()
    expect(await latest.loadCommitFiles(COMMIT)).toEqual(SHALLOW_COMPARE.entries)
  })

  it('does not load commits outside the current page or reuse retired row callbacks', async () => {
    const root = await mountProbe(<Probe owner={OWNER} />)
    await latest.loadCommitFiles(COMMIT)
    const retired = latest
    await act(async () =>
      root.render(
        <Probe
          owner={OWNER}
          historyState={{ status: 'ready', result: { ...HISTORY, items: [] } }}
        />
      )
    )

    expect(await latest.loadCommitFiles(COMMIT)).toEqual([])
    expect(await retired.loadCommitFiles(COMMIT)).toEqual([])
    retired.openCommitFile(COMMIT, COMPARE.entries[0])
    expect(mocks.compare).toHaveBeenCalledTimes(1)
    expect(mocks.openFile).not.toHaveBeenCalled()
  })
})
