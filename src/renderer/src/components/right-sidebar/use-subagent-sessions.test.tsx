// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { aiVaultSearchHitToSession } from './ai-vault-search-session'
import { searchHit } from '../../../../shared/ai-vault-search-test-fixture'
import { resolveAiVaultSessionWorktreeInfo } from '../../../../shared/ai-vault-session-worktree'
import { useSubagentSessions } from './use-subagent-sessions'

afterEach(() => vi.unstubAllGlobals())

it('derives loaded child and grandchild correspondence from current same-cwd evidence without refetching', async () => {
  const parent = aiVaultSearchHitToSession(
    { ...searchHit(), agent: 'omp', cwd: '/private/var/example' },
    'local'
  )
  const child = {
    ...parent,
    sessionId: 'child',
    filePath: '/child.jsonl',
    subagent: { parentSessionId: parent.sessionId, agentType: null, status: null }
  }
  const list = vi.fn().mockResolvedValue({ sessions: [child], issues: [] })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { listSubagentSessions: list } }
  })
  const owner = (session: typeof parent) =>
    resolveAiVaultSessionWorktreeInfo({
      session,
      worktrees: [
        {
          id: 'folder:example',
          repoId: 'folder-group',
          path: '/var/example',
          displayName: 'example'
        }
      ],
      activeWorktreeId: 'elsewhere'
    })?.worktreeId
  const { result, rerender, unmount } = renderHook(useSubagentSessions, { initialProps: parent })
  await act(async () => {})
  expect(owner(result.current.sessions[0])).toBeUndefined()
  rerender({ ...parent, cwdAliases: ['/var/example'] })
  const inherited = result.current.sessions[0]
  expect(owner(inherited)).toBe('folder:example')
  expect(list).toHaveBeenCalledTimes(1)
  unmount()

  const grandchild = {
    ...child,
    sessionId: 'grandchild',
    subagent: { ...child.subagent, parentSessionId: child.sessionId }
  }
  const different = { ...grandchild, sessionId: 'different', cwd: '/private/var/other' }
  const foreign = { ...grandchild, sessionId: 'foreign', executionHostId: 'runtime:other' as const }
  const wsl = {
    ...grandchild,
    sessionId: 'wsl',
    filePath: '//wsl.localhost/Ubuntu/grandchild.jsonl'
  }
  list.mockResolvedValue({ sessions: [grandchild, different, foreign, wsl], issues: [] })
  const nested = renderHook(useSubagentSessions, { initialProps: inherited })
  await act(async () => {})
  expect(nested.result.current.sessions.map((session) => session.cwdAliases)).toEqual([
    ['/var/example'],
    undefined,
    undefined,
    undefined
  ])
  nested.unmount()
})
