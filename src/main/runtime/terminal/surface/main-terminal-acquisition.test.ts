import { expect, it, vi } from 'vitest'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../../../shared/constants'
import { loadWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { mainTerminalSurfaces, type MainTerminalSurfacesHost } from './main-terminal-surfaces'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

function fixture(population: number) {
  const session = getDefaultWorkspaceSession()
  const registered = new Map<string, { worktreeId: string; incarnationId: string | null }>()
  const ids = Array.from({ length: population }, (_, i) =>
    i === 0 ? toRemoteRuntimePtyId('term_foreign', 'paired') : `pty-${i}`
  )
  for (const [i, ptyId] of ids.entries()) {
    const worktree = i % 2 === 0 ? 'folder:notes' : 'repo::/tmp/worktree'
    const tabId = `tab-${i}`
    const leafId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
    session.tabsByWorktree[worktree] = [
      ...(session.tabsByWorktree[worktree] ?? []),
      {
        id: tabId,
        worktreeId: worktree,
        ptyId,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: i,
        createdAt: 1
      }
    ]
    session.terminalLayoutsByTabId[tabId] = {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: ptyId }
    }
    if (i !== 0) {
      registered.set(ptyId, { worktreeId: worktree, incarnationId: null })
    }
  }
  const loaded = loadWorkspaceLayout('local', session, nameBasedLoadContext())
  const partition = vi.fn(() => loaded)
  const host: MainTerminalSurfacesHost = {
    store: () => ({
      getWorkspaceSessionHostIds: () => ['local'],
      getSettings: () => getDefaultSettings('/tmp/crew-main-capture')
    }),
    reads: () => ({ readPartition: partition, onLayoutOperationCommitted: () => () => {} }),
    homeHostId: () => 'local',
    registered: (id) => registered.get(id) ?? null,
    exited: () => false,
    live: () => true,
    paneStartFact: () => null,
    readyGraphPublisher: () => null,
    publish: () => {},
    heldRows: () => new Map(),
    replaceHeldRows: () => {},
    fenceExited: (rows) => rows
  }
  return { owner: mainTerminalSurfaces({}, () => host), partition, registered, ids }
}

it('captures real main partitions once and keeps paired/local/folder qualification and source ordering', () => {
  for (const population of [3, 30]) {
    const baseline = fixture(population)
    const candidate = fixture(population)
    const captured = candidate.owner.capturePaneLookup()
    for (const id of candidate.ids) {
      expect(captured(id)).toEqual(baseline.owner.findPaneForPty(id))
    }
    expect(candidate.partition).toHaveBeenCalledTimes(1)
    expect(baseline.partition).toHaveBeenCalledTimes(population)
    candidate.registered.get('pty-1')!.worktreeId = 'other-workspace'
    expect(captured('pty-1')).not.toBeNull()
    expect(candidate.owner.capturePaneLookup()('pty-1')).toBeNull()
    expect(captured(candidate.ids[0])).not.toBeNull()
    console.log('main partition acquisitions', { population, baseline: population, candidate: 1 })
  }
})
