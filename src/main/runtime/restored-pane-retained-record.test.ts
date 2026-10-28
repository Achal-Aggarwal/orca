import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { savedResumeResult } from '../ipc/pty/host-env/saved-resume-result'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')
const { committingSpawn } = await import('./bind-first-pane.test-fixture')

const PANE = { worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }
const PANE_KEY = `${PANE.tabId}:${PANE.leafId}`

describe('materializing a pane from its saved OpenCode record', () => {
  it.each(['unverifiable', 'admitted'] as const)(
    'retains the saved conversation and marks it live only after admission (%s)',
    async (verdict) => {
      const record: SleepingAgentSessionRecord = {
        paneKey: PANE_KEY,
        tabId: PANE.tabId,
        worktreeId: TEST_WORKTREE_ID,
        agent: 'opencode',
        providerSession: { key: 'session_id', id: 'ses_saved' },
        prompt: 'keep this conversation',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep',
        restoreOnTabOpenOnly: true,
        launchConfig: { agentCommand: 'opencode', agentArgs: '', agentEnv: {} }
      }
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
        })
      )
      const runtime = new OrcaRuntimeService(runtimeStore)
      const receipt = savedResumeResult({
        verdict,
        refused: { agent: record.agent, providerSession: record.providerSession }
      })
      const spawn = vi.fn<NonNullable<RuntimePtyController['spawn']>>(async (args) => {
        expect(args).toMatchObject({
          launchAgent: 'opencode',
          resumeOrigin: 'saved',
          resumeProviderSession: record.providerSession
        })
        return { id: 'materialized-pty', launchAgent: 'opencode', ...receipt }
      })
      runtime.setPtyController({
        spawn: committingSpawn(runtime, spawn),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await expect(runtime.ensureRestoredPaneStarted(PANE)).resolves.toMatchObject({
        id: 'materialized-pty'
      })
      // Drain the actual durable edit queue after materialization's fire-and-forget mark-live.
      await runtime['commitWorkspaceSessionEdit']('local', () => null)

      expect(spawn).toHaveBeenCalledOnce()
      expect(runtime.getTerminalLaunchResult('materialized-pty')).toMatchObject(receipt)
      expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toEqual({
        ...record,
        origin: verdict === 'admitted' ? 'live' : 'worktree-sleep'
      })
    }
  )
})
