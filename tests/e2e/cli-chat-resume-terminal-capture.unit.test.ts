// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { captureSourceTerminal } from '@/components/tab-bar/cli-chat-resume-terminal-capture'
import { buildMirroredTerminalTabs } from '@/runtime/web-session-tabs-sync/terminal-build'
import { toRemoteRuntimePtyId } from '../../src/shared/remote-runtime/remote-runtime-pty-id'
import {
  createHarness,
  WORKTREE_ID,
  TAB_ID,
  LEAF_ID,
  PTY_ID,
  INCARNATION_ID
} from '../../src/main/runtime/__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  rpc.mockReset()
})
function source(ptyId: string | undefined, executionHostId: 'local' | 'runtime:paired' = 'local') {
  return {
    workspaceId: WORKTREE_ID,
    tabId: TAB_ID,
    paneKey: `${TAB_ID}:${LEAF_ID}`,
    agent: 'codex' as const,
    providerSessionId: 'conversation',
    executionHostId,
    ptyId
  }
}
function seed(harness: ReturnType<typeof createHarness>) {
  const session = harness.getSession()
  useAppStore.setState({
    tabsByWorktree: session.tabsByWorktree,
    terminalLayoutsByTabId: session.terminalLayoutsByTabId
  })
}

it('captures the authenticated original after earned shell exit and cleared renderer binding, then closes without another stop', async () => {
  const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
  const retained = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  const settle = harness.runtime.intentionalPtyStops.mark(PTY_ID, 'reversible', INCARNATION_ID)
  await harness.runtime.onPtyExit(PTY_ID, 0, INCARNATION_ID, { hostExitConfirmed: true })
  settle(true)
  harness.runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Ended',
        activeLeafId: LEAF_ID,
        layout: { type: 'leaf', leafId: LEAF_ID }
      }
    ],
    leaves: [
      { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 7, ptyId: null }
    ]
  })
  harness.editSession((state) => ({
    ...state,
    terminalLayoutsByTabId: {
      ...state.terminalLayoutsByTabId,
      [TAB_ID]: { ...state.terminalLayoutsByTabId[TAB_ID], ptyIdsByLeafId: {} }
    }
  }))
  harness.runtime.dropArchivedPtyRecord(PTY_ID)
  seed(harness)
  rpc.mockImplementation(async () => ({
    terminal: harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  }))
  const captured = await captureSourceTerminal(source(undefined))
  expect(captured?.handle).toBe(retained.handle)
  if (!captured?.presentation) {
    throw new Error('Expected authenticated original')
  }
  harness.setCloseTerminalTabAction(() => {})
  await expect(
    harness.runtime.closeTerminal(captured.handle, captured.incarnationId, captured.presentation)
  ).resolves.toMatchObject({ ptyKilled: true })
  expect(harness.stopAndWait).not.toHaveBeenCalled()
  expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
})

it.each(['row', 'incarnation', 'pty', 'workspace', 'leaf', 'host'] as const)(
  'refuses changed %s facts across resolve without recapturing',
  async (change) => {
    const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
    seed(harness)
    let resolvedTerminal: ReturnType<typeof harness.runtime.resolveTerminalPane> | undefined
    rpc.mockImplementation(async () => {
      if (change === 'row') {
        harness.editSession((state) => ({
          ...state,
          tabsByWorktree: {
            ...state.tabsByWorktree,
            [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID].map((row) => ({
              ...row,
              generation: (row.generation ?? 0) + 1
            }))
          }
        }))
      }
      if (change === 'incarnation') {
        harness.replacePersistedIncarnation('successor')
      }
      const terminal = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
      resolvedTerminal = terminal
      if (change === 'host') {
        terminal.executionHostId = 'ssh:successor'
      }
      if (change === 'pty') {
        terminal.ptyId = 'successor'
      }
      if (change === 'workspace' && terminal.presentation) {
        terminal.presentation.identity.worktreeId = 'other'
      }
      if (change === 'leaf' && terminal.presentation) {
        terminal.presentation.identity.leafId = 'other'
      }
      return { terminal }
    })
    expect(await captureSourceTerminal(source(PTY_ID))).toBeNull()
    if (change === 'incarnation') {
      expect(rpc).toHaveResolvedWith({ terminal: resolvedTerminal })
      expect(resolvedTerminal).toMatchObject({ ptyId: PTY_ID, incarnationId: INCARNATION_ID })
      expect(resolvedTerminal).not.toHaveProperty('presentation')
    }
  }
)

it('captures a real mirrored source on host coordinates and keeps client continuity independent of host clocks', async () => {
  const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
  harness.editSession((session) => ({
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [WORKTREE_ID]: session.tabsByWorktree[WORKTREE_ID].map((row) => ({ ...row, generation: 7 }))
    }
  }))
  const snapshot = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const terminal = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  const [mirror] = buildMirroredTerminalTabs(snapshot, 'paired', new Map(), {}, {}, 0, 9000)
  if (!mirror || !terminal.presentation) {
    throw new Error('Expected a real published terminal')
  }
  const mirrored = {
    ...source(mirror.layout.ptyIdsByLeafId?.[LEAF_ID], 'runtime:paired'),
    tabId: mirror.tab.id,
    paneKey: `${mirror.tab.id}:${LEAF_ID}`
  }
  const seedMirror = () =>
    useAppStore.setState({
      tabsByWorktree: { [WORKTREE_ID]: [mirror.tab] },
      terminalLayoutsByTabId: { [mirror.tab.id]: mirror.layout },
      terminalPtyIncarnationsByPaneKey: {},
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'runtime:paired'
    })
  seedMirror()
  let duringResolve = () => {}
  rpc.mockImplementation(
    async (_target, method, params: { paneKey: string; worktreeId: string }) => {
      expect(method).toBe('terminal.resolvePane')
      expect(params).toEqual({ paneKey: `${TAB_ID}:${LEAF_ID}`, worktreeId: WORKTREE_ID })
      duringResolve()
      return { terminal: harness.runtime.resolveTerminalPane(params.paneKey, params.worktreeId) }
    }
  )
  expect(mirrored.tabId).not.toBe(terminal.presentation.identity.tabId)
  expect(mirror.tab.createdAt).not.toBe(terminal.presentation.identity.createdAt)
  expect(mirror.tab.generation ?? 0).not.toBe(terminal.presentation.identity.generation)
  expect(await captureSourceTerminal(mirrored)).toEqual({
    target: { kind: 'environment', environmentId: 'paired' },
    handle: terminal.handle,
    incarnationId: terminal.incarnationId,
    presentation: terminal.presentation
  })
  for (const change of ['generation', 'adoption', 'binding', 'owner', 'incarnation'] as const) {
    seedMirror()
    duringResolve = () =>
      useAppStore.setState({
        ...(change === 'generation' || change === 'adoption'
          ? {
              tabsByWorktree: {
                [WORKTREE_ID]: [
                  {
                    ...mirror.tab,
                    ...(change === 'generation' ? { generation: 1 } : { createdAt: 9001 })
                  }
                ]
              }
            }
          : {}),
        ...(change === 'binding'
          ? {
              terminalLayoutsByTabId: {
                [mirror.tab.id]: {
                  ...mirror.layout,
                  ptyIdsByLeafId: { [LEAF_ID]: toRemoteRuntimePtyId('successor', 'paired') }
                }
              }
            }
          : {}),
        ...(change === 'owner' ? { activeWorkspaceExecutionHostId: 'runtime:successor' } : {}),
        ...(change === 'incarnation'
          ? {
              terminalPtyIncarnationsByPaneKey: { [mirrored.paneKey]: 'successor' }
            }
          : {})
      })
    expect(await captureSourceTerminal(mirrored), change).toBeNull()
  }
  seedMirror()
  duringResolve = () => {}
  expect(
    await captureSourceTerminal({ ...mirrored, ptyId: toRemoteRuntimePtyId(terminal.handle) })
  ).toBeNull()
  expect(await captureSourceTerminal({ ...mirrored, ptyId: undefined })).toBeNull()
  expect(await captureSourceTerminal({ ...mirrored, executionHostId: 'local' })).toBeNull()
  rpc.mockImplementation(async (_target, _method, params) => ({
    terminal: {
      ...harness.runtime.resolveTerminalPane(params.paneKey, params.worktreeId),
      handle: 'different'
    }
  }))
  expect(await captureSourceTerminal(mirrored)).toBeNull()
})

it('requires a real row/leaf for the new missing-binding exception while retaining existing nonnull-source admission', async () => {
  const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
  const terminal = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  rpc.mockResolvedValue({ terminal })
  expect(await captureSourceTerminal(source(undefined))).toBeNull()
  expect(await captureSourceTerminal(source(PTY_ID))).toMatchObject({ handle: terminal.handle })
  const proxy = toRemoteRuntimePtyId(terminal.handle, 'paired')
  expect(await captureSourceTerminal(source(proxy, 'runtime:paired'))).toMatchObject({
    handle: terminal.handle
  })
})
