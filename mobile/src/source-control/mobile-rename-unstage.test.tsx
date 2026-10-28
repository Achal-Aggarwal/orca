import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bulkUnstageFiles, unstageFile } from '../../../src/main/git/source-control/staging'
import { buildMobileDiffReviewQueue } from '../session/mobile-diff-review-queue'
import { useMobileDiffReviewGitActions } from '../session/use-mobile-diff-review-git-actions'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'
import { makeRenderFileRow } from './MobileSourceControlFileRows'
import { buildMobileGitStatusEntryViews } from './mobile-source-control-screen-state'
import { useMobileGitRequests } from './use-mobile-git-requests'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ArrowDownUp: 'ArrowDownUp',
  ArrowUp: 'ArrowUp',
  Check: 'Check',
  ChevronRight: 'ChevronRight',
  CloudUpload: 'CloudUpload',
  FileText: 'FileText',
  GitBranch: 'GitBranch',
  GitPullRequestArrow: 'GitPullRequestArrow',
  History: 'History',
  Minus: 'Minus',
  Plus: 'Plus',
  RefreshCw: 'RefreshCw',
  Trash2: 'Trash2'
}))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
vi.mock('../../../src/main/git/source-control/git-read-cache-invalidation', () => ({
  invalidateGitReadCaches: () => {}
}))
vi.mock('../../../src/main/git/source-control/drive-checkout-suspect-writes', () => ({
  redoWriteForDriveCheckoutSuspects: async () => {}
}))
vi.mock('../../../src/main/git/runner', () => ({
  gitExecFileAsync: async (args: string[], options: { cwd: string; stdin?: string }) => {
    const result = await runProcess({
      program: 'git',
      args,
      cwd: options.cwd,
      input: options.stdin
    })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }
}))

const OLD_PATH = 'before[1].txt'
const NEW_PATH = 'after[1].txt'
const META = { runtimeId: 'host' }
let directory: string
const mounted: ReactTestRenderer[] = []

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-mobile-rename-'))
  await git('init', '-q')
  await git('config', 'user.name', 'Audit')
  await git('config', 'user.email', 'audit@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  await writeFile(join(directory, OLD_PATH), 'retained content\n')
  await writeFile(join(directory, 'unrelated.txt'), 'base\n')
  await git('add', '.')
  await git('commit', '-qm', 'base')
  await writeFile(join(directory, 'unrelated.txt'), 'staged unrelated edit\n')
  await git('add', '--', 'unrelated.txt')
})

afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount()
    }
  })
  await rm(directory, { recursive: true, force: true })
})

type HostMode = 'current' | 'legacy' | 'failure' | 'lost-reply' | 'legacy-failure'

async function mountAction(surface: 'row' | 'review', renamed: boolean, mode: HostMode) {
  if (renamed) {
    await git('mv', '--', OLD_PATH, NEW_PATH)
  } else {
    await writeFile(join(directory, OLD_PATH), 'staged edit\n')
    await git('add', '--', OLD_PATH)
  }
  const entry = {
    area: 'staged' as const,
    path: renamed ? NEW_PATH : OLD_PATH,
    oldPath: renamed ? OLD_PATH : undefined,
    status: renamed ? ('renamed' as const) : ('modified' as const)
  }
  const calls: string[] = []
  const errors: (string | null)[] = []
  const busy: (string | null)[] = []
  const client = stubRpcClient({
    sendRequest: async (method, params): Promise<RpcResponse> => {
      calls.push(method)
      const refused = (code: string): RpcResponse => ({
        id: 'call',
        ok: false,
        error: { code, message: code },
        _meta: META
      })
      if (method === 'git.bulkUnstage') {
        if (mode === 'legacy' || mode === 'legacy-failure') {
          return refused('method_not_found')
        }
        if (mode === 'failure') {
          return refused('runtime_error')
        }
        if (mode === 'lost-reply') {
          throw new Error('Reply lost')
        }
        if (
          !params ||
          typeof params !== 'object' ||
          !('filePaths' in params) ||
          !Array.isArray(params.filePaths) ||
          !params.filePaths.every((path: unknown) => typeof path === 'string')
        ) {
          throw new Error('Expected bulk paths')
        }
        await bulkUnstageFiles(directory, params.filePaths)
      } else if (method === 'git.unstage') {
        if (mode === 'legacy-failure') {
          return refused('runtime_error')
        }
        if (
          !params ||
          typeof params !== 'object' ||
          !('filePath' in params) ||
          typeof params.filePath !== 'string'
        ) {
          throw new Error('Expected single path')
        }
        await unstageFile(directory, params.filePath)
      } else {
        throw new Error(`Unexpected ${method}`)
      }
      return { id: 'call', ok: true, result: undefined, _meta: META }
    }
  })
  const queue = buildMobileDiffReviewQueue({
    worktreeId: 'wt',
    statusEntries: [entry],
    branchEntries: [],
    comments: [],
    reviewState: { version: 1, files: {} }
  })
  const action: { run: (() => Promise<void>) | null; pending: Promise<unknown> | null } = {
    run: null,
    pending: null
  }
  const refreshed = vi.fn(async () => {})
  function Probe() {
    const { sendGitRequest } = useMobileGitRequests({
      client,
      connState: 'connected',
      worktreeId: 'wt'
    })
    const review = useMobileDiffReviewGitActions({
      client,
      connState: 'connected',
      worktreeId: 'wt',
      queue,
      setActionError: (value) => errors.push(typeof value === 'function' ? value(null) : value),
      setBusyAction: (value) => busy.push(typeof value === 'function' ? value(null) : value),
      loadReviewData: refreshed
    })
    action.run = async () => review.runGitMutation('git.unstage', queue[0])
    if (surface === 'review') {
      return null
    }
    const Row = makeRenderFileRow({
      busyAction: null,
      openingPath: null,
      openingBranchPath: null,
      openFile: async () => {},
      setDiscardTarget: () => {},
      runGitAction: async (_id, method, params) => {
        action.pending = sendGitRequest(method, params).catch((error: unknown) => {
          errors.push(error instanceof Error ? error.message : String(error))
        })
        await action.pending
        return true
      }
    })
    return createElement(Row, { item: buildMobileGitStatusEntryViews([entry])[0] })
  }
  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(createElement(Probe))
  })
  if (!renderer) {
    throw new Error('Missing mounted action')
  }
  mounted.push(renderer)
  const current = renderer
  await act(async () => {
    if (surface === 'row') {
      current.root.findByProps({ accessibilityLabel: `Unstage ${entry.path}` }).props.onPress()
      await action.pending
    } else {
      await action.run?.()
    }
  })
  return { calls, errors, busy, refreshed }
}

describe.each(['row', 'review'] as const)('mobile rename Unstage from %s', (surface) => {
  it.each(['current', 'legacy'] as const)('resets both rename paths on a %s host', async (mode) => {
    const result = await mountAction(surface, true, mode)
    expect(await git('diff', '--cached', '--name-only')).toBe('unrelated.txt\n')
    expect(await readFile(join(directory, NEW_PATH), 'utf8')).toBe('retained content\n')
    expect(result.errors.filter(Boolean)).toEqual([])
    expect(result.calls).toEqual(
      mode === 'current' ? ['git.bulkUnstage'] : ['git.bulkUnstage', 'git.unstage', 'git.unstage']
    )
  })

  it('keeps an ordinary file on the single-path operation', async () => {
    const result = await mountAction(surface, false, 'current')
    expect(await git('diff', '--cached', '--name-only')).toBe('unrelated.txt\n')
    expect(result.calls).toEqual(['git.unstage'])
  })

  it.each(['failure', 'lost-reply', 'legacy-failure'] as const)(
    'reports %s without replaying an ambiguous mutation',
    async (mode) => {
      const result = await mountAction(surface, true, mode)
      expect(await git('diff', '--cached', '--name-status')).toContain(
        `R100\t${OLD_PATH}\t${NEW_PATH}`
      )
      expect(await git('diff', '--cached', '--name-only')).toContain('unrelated.txt')
      expect(result.errors.some(Boolean)).toBe(true)
      expect(result.calls).toEqual(
        mode === 'legacy-failure' ? ['git.bulkUnstage', 'git.unstage'] : ['git.bulkUnstage']
      )
      if (surface === 'review') {
        expect(result.busy.at(-1)).toBeNull()
        expect(result.refreshed).not.toHaveBeenCalled()
      }
    }
  )
})
