import { describe, expect, it, vi } from 'vitest'
import * as repoWorktreeAdminFingerprint from '../repo-worktree-admin-fingerprint'
import * as wslUncAccessGate from '../../wsl/wsl-unc-access-gate'
import { OrcaRuntimeService, listWorktrees } from '../orca-runtime-test-mocks.spec'
import { makeWorktreeInfo, store } from '../orca-runtime-test-fixtures.spec'

const WSL_REPO_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

function runtimeFor(path: string): OrcaRuntimeService {
  const repos = [{ ...store.getRepos()[0], id: 'wsl-repo', path }]
  const runtimeStore = {
    ...store,
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared runtime fixture store, as sibling scan-cache specs build it.
  return new OrcaRuntimeService(runtimeStore as never)
}

describe('worktree scans of a stopped WSL distro (E9)', () => {
  it('keeps the known rows and never reads the admin dir or runs Git while the distro is stopped', async () => {
    vi.mocked(listWorktrees).mockReset()
    vi.mocked(listWorktrees).mockImplementation(async (repoPath) => [makeWorktreeInfo(repoPath)])
    vi.useFakeTimers({ now: 0 })
    const fingerprint = vi
      .spyOn(repoWorktreeAdminFingerprint, 'readRepoWorktreeAdminFingerprint')
      .mockResolvedValue(null)
    const blocked = vi.spyOn(wslUncAccessGate, 'blockedWslDistroForPath').mockResolvedValue(null)
    // This test runs off Windows; the gate only asks about paths it maps to a distro.
    const distroFor = vi.spyOn(wslUncAccessGate, 'wslDistroForPath').mockReturnValue('Ubuntu')
    try {
      const runtime = runtimeFor(WSL_REPO_PATH)
      const running = await runtime.listDetectedManagedWorktrees('id:wsl-repo')
      expect(listWorktrees).toHaveBeenCalledTimes(1)

      blocked.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
      fingerprint.mockClear()
      vi.setSystemTime(10 * 60_000)
      const stopped = await runtime.listDetectedManagedWorktrees('id:wsl-repo')

      expect(listWorktrees).toHaveBeenCalledTimes(1)
      expect(fingerprint).not.toHaveBeenCalled()
      expect(stopped.worktrees.map((worktree) => worktree.path)).toEqual(
        running.worktrees.map((worktree) => worktree.path)
      )
      expect(blocked).toHaveBeenCalledWith(WSL_REPO_PATH, undefined)

      // Once it runs again, the next scan goes to Git as before.
      blocked.mockResolvedValue(null)
      vi.setSystemTime(20 * 60_000)
      await runtime.listDetectedManagedWorktrees('id:wsl-repo')
      expect(listWorktrees).toHaveBeenCalledTimes(2)
    } finally {
      distroFor.mockRestore()
      blocked.mockRestore()
      fingerprint.mockRestore()
      vi.useRealTimers()
    }
  })

  it('scans a host repo exactly as before', async () => {
    vi.mocked(listWorktrees).mockReset()
    vi.mocked(listWorktrees).mockImplementation(async (repoPath) => [makeWorktreeInfo(repoPath)])
    const blocked = vi.spyOn(wslUncAccessGate, 'blockedWslDistroForPath')
    try {
      await runtimeFor('/tmp/host-repo').listDetectedManagedWorktrees('id:wsl-repo')
      expect(listWorktrees).toHaveBeenCalledTimes(1)
      // A path no distro owns never even asks the running gate.
      expect(blocked).not.toHaveBeenCalled()
    } finally {
      blocked.mockRestore()
    }
  })
})
