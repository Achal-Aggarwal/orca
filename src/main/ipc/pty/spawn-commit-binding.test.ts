import '../../runtime/orca-runtime-test-mocks.spec'
import { expect, it, vi } from 'vitest'
import {
  fixture,
  admitRuntimeSpawnPane
} from '../../persistence/loading-store/profile-state-delayed-authority-fixture'
import type { IPtyProvider, PtySpawnResult } from '../../providers/pty-provider-contract'
import { savePtySpawnPaneBinding } from './spawn-commit-binding'

vi.mock('./provider/liveness', () => ({ finishPtyShutdown: vi.fn() }))
const worktreeId = 'repo-local::/fixture/local'
const tabId = '11111111-1111-4111-8111-111111111111'
const leafId = '22222222-2222-4222-8222-222222222222'
const incarnationId = '33333333-3333-4333-8333-333333333333'

it('reconciles a dispatched child through real topology creation after a queued binding loses to newer work', async () => {
  const { store, authority } = await fixture()
  await admitRuntimeSpawnPane(store, { worktreeId, tabId, leafId })
  const pause = authority.pause()
  const newer = store.persistPtyBinding({ worktreeId, tabId, leafId, ptyId: 'B', incarnationId })
  await pause.started.promise
  const shutdown = vi.fn()
  const killFenced = vi.fn(async () => ({
    outcome: 'refused' as const,
    reason: 'unverifiable' as const
  }))
  // SAFETY: this schedule reaches only optional fenced cleanup, never any ordinary provider operation.
  const provider = { killFenced, shutdown } as unknown as IPtyProvider
  const result: PtySpawnResult = {
    id: 'A',
    incarnationId,
    switchCleanupWitness: 'captured-before-spawn-reply'
  }
  const saving = savePtySpawnPaneBinding(
    {
      result,
      provider,
      args: {
        switchExecution: {
          invocationId: 'click',
          signal: new AbortController().signal,
          remaining: () => 100,
          check: () => {
            throw new Error('revoked')
          }
        }
      },
      deps: {}
    },
    {
      store,
      binding: { worktreeId, tabId, leafId, ptyId: 'A', incarnationId },
      refusal: 'terminal_pane_owner_changed',
      failureLog: 'expected binding conflict'
    },
    null
  )
  pause.finish.resolve()
  await newer
  await saving
  expect(shutdown).not.toHaveBeenCalled()
  expect(killFenced).toHaveBeenCalledOnce()
  expect(result.switchOutcomeUnknown).toBe(true)
  const recovered = result.switchRecoveredSurface!
  expect(recovered.tabId).not.toBe(tabId)
  const session = store.getWorkspaceSession()
  expect(session.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId?.[leafId]).toBe('B')
  expect(
    session.terminalLayoutsByTabId?.[recovered.tabId]?.ptyIdsByLeafId?.[recovered.leafId]
  ).toBe('A')
  expect(session.tabsByWorktree[worktreeId].some((row) => row.id === recovered.tabId)).toBe(true)
})
