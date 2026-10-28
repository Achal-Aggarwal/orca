import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { WslHostConnectionState } from '../../../../shared/wsl-host-types'

let state: Record<string, unknown> = {}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => state }
}))

vi.mock('./use-worktree-sleep-state', () => ({
  selectIsSleepingWorktree: () => false
}))

const WSL_ENV = 'env-wsl'
const PAIRED_ENV = 'env-paired'

function setHostState(args: {
  wslState?: WslHostConnectionState
  pairedConnected?: boolean
}): void {
  state = {
    activeView: 'terminal',
    sleepingAgentSessionsByPaneKey: {},
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    runtimeEnvironments: [
      { id: WSL_ENV, orcadDeployment: { kind: 'wsl', distro: 'Ubuntu' } },
      { id: PAIRED_ENV }
    ],
    runtimeStatusByEnvironmentId: new Map(
      args.pairedConnected ? [[PAIRED_ENV, { status: { runtimeId: 'r1' }, checkedAt: 1 }]] : []
    ),
    wslHostStatuses: args.wslState
      ? {
          [WSL_ENV]: {
            environmentId: WSL_ENV,
            distro: 'Ubuntu',
            state: args.wslState,
            detail: null
          }
        }
      : {}
  }
}

async function canPress(rowHostId: ExecutionHostId): Promise<boolean> {
  const { canActivateWorktreeOnPress } = await import('./worktree-press-activation-eligibility')
  return canActivateWorktreeOnPress({ worktreeId: 'wt-1', rowHostId, isSshDisconnected: false })
}

describe('press activation host readiness', () => {
  beforeEach(() => {
    setHostState({})
  })

  it('keeps click activation for a WSL host unless it reports ready', async () => {
    expect(await canPress(toRuntimeExecutionHostId(WSL_ENV))).toBe(false)
    setHostState({ wslState: 'distro-stopped' })
    expect(await canPress(toRuntimeExecutionHostId(WSL_ENV))).toBe(false)
    setHostState({ wslState: 'ready' })
    expect(await canPress(toRuntimeExecutionHostId(WSL_ENV))).toBe(true)
  })

  it('requires a connected paired runtime and never presses into a recipe VM target', async () => {
    expect(await canPress(toRuntimeExecutionHostId(PAIRED_ENV))).toBe(false)
    setHostState({ pairedConnected: true })
    expect(await canPress(toRuntimeExecutionHostId(PAIRED_ENV))).toBe(true)
    expect(await canPress(toSshExecutionHostId('runtime-ssh-vm1'))).toBe(false)
    expect(await canPress(toSshExecutionHostId('devbox'))).toBe(true)
    expect(await canPress('local')).toBe(true)
  })
})
