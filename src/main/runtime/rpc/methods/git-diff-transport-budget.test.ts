import '../unused-default-rpc-methods.test-fixture'
// Cap every GitDiffResult producer; any uncapped diff method can close a remote socket.
import { describe, expect, it, vi } from 'vitest'
import {
  REMOTE_RPC_MAX_CONTENT_BYTES,
  remoteRpcContentBudget
} from '../../../../shared/remote-rpc-content-budget'
import { assertGitDiffWithinTransportBudget } from '../../../../shared/git-diff-transport-budget'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { GIT_METHODS } from './git'

const OVERSIZED_BASE64 = 'A'.repeat(REMOTE_RPC_MAX_CONTENT_BYTES + 1024)

const OVERSIZED_DIFF: GitDiffResult = {
  kind: 'binary',
  originalContent: '',
  modifiedContent: OVERSIZED_BASE64,
  isImage: true,
  mimeType: 'image/png',
  originalIsBinary: false,
  modifiedIsBinary: true
}

type DiffRuntimeMethod = 'getRuntimeGitDiff' | 'getRuntimeGitBranchDiff' | 'getRuntimeGitCommitDiff'

const CASES: readonly {
  method: string
  runtimeMethod: DiffRuntimeMethod
  params: Record<string, unknown>
}[] = [
  {
    method: 'git.diff',
    runtimeMethod: 'getRuntimeGitDiff',
    params: { worktree: 'id:wt-1', filePath: 'assets/logo.png', staged: false }
  },
  {
    method: 'git.branchDiff',
    runtimeMethod: 'getRuntimeGitBranchDiff',
    params: {
      worktree: 'id:wt-1',
      compare: { mergeBase: 'a'.repeat(40), headOid: 'b'.repeat(40) },
      filePath: 'assets/logo.png'
    }
  },
  {
    method: 'git.commitDiff',
    runtimeMethod: 'getRuntimeGitCommitDiff',
    params: { worktree: 'id:wt-1', commitOid: 'c'.repeat(40), filePath: 'assets/logo.png' }
  }
]

function stubRuntime(runtimeMethod: DiffRuntimeMethod) {
  const enforceBudget = vi.fn((maxContentBytes?: number) =>
    assertGitDiffWithinTransportBudget(OVERSIZED_DIFF, maxContentBytes)
  )
  const methods = {
    getRuntimeGitDiff: vi.fn<OrcaRuntimeService['getRuntimeGitDiff']>(
      async (_worktree, _filePath, _staged, _compareAgainstHead, maxContentBytes) =>
        enforceBudget(maxContentBytes)
    ),
    getRuntimeGitBranchDiff: vi.fn<OrcaRuntimeService['getRuntimeGitBranchDiff']>(
      async (_worktree, _compare, _filePath, _oldPath, maxContentBytes) =>
        enforceBudget(maxContentBytes)
    ),
    getRuntimeGitCommitDiff: vi.fn<OrcaRuntimeService['getRuntimeGitCommitDiff']>(
      async (_worktree, _args, maxContentBytes) => enforceBudget(maxContentBytes)
    )
  }
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    [runtimeMethod]: methods[runtimeMethod]
  }
  return {
    // SAFETY: each dispatch reaches only the selected, signature-checked diff method and runtime id.
    runtime: runtime as unknown as OrcaRuntimeService,
    enforceBudget
  }
}

function makeRequest(method: string, params: Record<string, unknown>): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

async function dispatchRemote(
  runtime: OrcaRuntimeService,
  method: string,
  params: Record<string, unknown>,
  clientKind: 'mobile' | 'runtime'
): Promise<RpcResponse> {
  const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })
  const replies: string[] = []
  await dispatcher.dispatchStreaming(makeRequest(method, params), (reply) => replies.push(reply), {
    clientKind
  })
  return JSON.parse(replies[0]!) as RpcResponse
}

describe('remote git diff transport budget', () => {
  it.each(CASES)('caps $method for a mobile client', async ({ method, runtimeMethod, params }) => {
    const { runtime, enforceBudget } = stubRuntime(runtimeMethod)

    const response = await dispatchRemote(runtime, method, params, 'mobile')

    expect(enforceBudget).toHaveBeenCalledWith(remoteRpcContentBudget('req-1'))
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'diff_too_large', data: { maxBytes: remoteRpcContentBudget('req-1') } }
    })
  })

  it.each(CASES)(
    'caps $method for a remote desktop client',
    async ({ method, runtimeMethod, params }) => {
      const { runtime, enforceBudget } = stubRuntime(runtimeMethod)

      const response = await dispatchRemote(runtime, method, params, 'runtime')

      expect(enforceBudget).toHaveBeenCalledWith(remoteRpcContentBudget('req-1'))
      expect(response).toMatchObject({ ok: false, error: { code: 'diff_too_large' } })
    }
  )

  it.each(['mobile', 'runtime'] as const)(
    'caps a staged rename without losing its source for a %s client',
    async (clientKind) => {
      const { runtime, enforceBudget } = stubRuntime('getRuntimeGitDiff')
      const maxContentBytes = remoteRpcContentBudget('req-1')

      const response = await dispatchRemote(
        runtime,
        'git.diff',
        {
          worktree: 'id:wt-1',
          filePath: 'assets/logo.png',
          staged: true,
          oldPath: 'assets/old-logo.png'
        },
        clientKind
      )

      expect(runtime.getRuntimeGitDiff).toHaveBeenCalledWith(
        'id:wt-1',
        'assets/logo.png',
        true,
        undefined,
        maxContentBytes,
        'assets/old-logo.png'
      )
      expect(enforceBudget).toHaveBeenCalledWith(maxContentBytes)
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'diff_too_large', data: { maxBytes: maxContentBytes } }
      })
    }
  )

  it('charges a long request id against the remote content budget', async () => {
    const { runtime, enforceBudget } = stubRuntime('getRuntimeGitDiff')
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })
    const requestId = '\u0001'.repeat(8_192)
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      { ...makeRequest('git.diff', CASES[0]!.params), id: requestId },
      (reply) => replies.push(reply),
      { clientKind: 'mobile' }
    )

    expect(enforceBudget).toHaveBeenCalledWith(remoteRpcContentBudget(requestId))
    expect(Buffer.byteLength(replies[0]!, 'utf8')).toBeLessThanOrEqual(
      REMOTE_RPC_MAX_CONTENT_BYTES + 8 * 1024
    )
  })

  // In-process/Unix-socket callers have no clientKind and retain full diff fidelity.
  it.each(CASES)(
    'leaves $method uncapped for a local caller',
    async ({ method, runtimeMethod, params }) => {
      const { runtime, enforceBudget } = stubRuntime(runtimeMethod)
      const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

      const response = await dispatcher.dispatch(makeRequest(method, params))

      expect(enforceBudget).toHaveBeenCalledWith(undefined)
      expect(response).toMatchObject({
        ok: true,
        result: { kind: 'binary', modifiedContent: OVERSIZED_BASE64 }
      })
    }
  )
})
