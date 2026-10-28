// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'

const mocks = vi.hoisted(() => ({ resolveFile: vi.fn(), call: vi.fn(), legacyCall: vi.fn() }))
vi.mock('./web-runtime-worktree-catalog', () => ({
  resolveRuntimeFilePath: mocks.resolveFile,
  resolveRuntimeWorktreeByPath: vi.fn()
}))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironment: () => ({ id: 'remote' }),
  updateEnvironmentFromResponse: () => {}
}))
vi.mock('../../runtime/abortable-runtime-environment-call', () => ({
  callAbortableRuntimeEnvironment: mocks.call
}))
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: mocks.legacyCall }))
import { createGitApi } from './web-git-api'
import { webGitReadAbortControllers } from './web-git-read-requests'

afterEach(() => {
  for (const controller of webGitReadAbortControllers.values()) {
    controller.abort()
  }
  webGitReadAbortControllers.clear()
  vi.resetAllMocks()
})

describe('web diff request cancellation', () => {
  it('cancels during catalog resolution without issuing host work', async () => {
    let resolve!: (value: unknown) => void
    mocks.resolveFile.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const api = createGitApi()
    const result = api.diff({
      worktreePath: '/repo',
      filePath: 'file.txt',
      staged: false,
      requestToken: 'read'
    })
    await api.cancelDiff({ requestToken: 'read' })
    resolve({ worktree: { id: 'wt' }, relativePath: 'file.txt' })
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.call).not.toHaveBeenCalled()
    expect(webGitReadAbortControllers.size).toBe(0)
  })

  it('retires the issued bridge while a legacy request still succeeds', async () => {
    mocks.resolveFile.mockResolvedValue({ worktree: { id: 'wt' }, relativePath: 'file.txt' })
    mocks.call.mockImplementation((_environment, _method, _params, _timeout, signal: AbortSignal) =>
      waitForPromiseWithSignal(new Promise(() => {}), signal)
    )
    const api = createGitApi()
    const result = api.commitDiff({
      worktreePath: '/repo',
      filePath: 'file.txt',
      commitOid: 'a'.repeat(40),
      requestToken: 'read'
    })
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await api.cancelDiff({ requestToken: 'read' })
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(webGitReadAbortControllers.size).toBe(0)
    const live = { kind: 'text', originalContent: '', modifiedContent: 'live' }
    mocks.legacyCall.mockResolvedValue(live)
    await expect(
      api.diff({ worktreePath: '/repo', filePath: 'file.txt', staged: false })
    ).resolves.toBe(live)
  })
})
