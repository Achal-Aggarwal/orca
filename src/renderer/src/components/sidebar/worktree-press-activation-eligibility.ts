import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { workspaceHasSleepingAgentSessions } from '@/lib/worktree-agent-activation-gate'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { workspaceOwnerHostId } from '@/lib/workspace-row-owner-host'
import {
  isConnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from '@/runtime/runtime-host-connection-state'
import {
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { isWslHostRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { selectIsSleepingWorktree } from './use-worktree-sleep-state'

type PressHostState = Pick<
  AppState,
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
  | 'wslHostStatuses'
>

// Focusing a workspace can boot its host: a WSL distro on focus, a recipe VM on resume. Only proven-ready hosts qualify.
function isHostReadyForPress(state: PressHostState, hostId: ExecutionHostId | null): boolean {
  const host = parseExecutionHostId(hostId)
  if (!host) {
    return false
  }
  if (host.kind === 'local') {
    return true
  }
  if (host.kind === 'ssh') {
    // Runtime-owned targets are recipe VMs; they publish no connection state to prove they are running.
    return !isRuntimeOwnedSshTargetId(host.targetId)
  }
  const environment = state.runtimeEnvironments.find(({ id }) => id === host.environmentId)
  if (environment && isWslHostRuntimeEnvironment(environment)) {
    return state.wslHostStatuses[host.environmentId]?.state === 'ready'
  }
  return isConnectedRuntimeHostState(
    runtimeHostConnectionStateForEntry(state.runtimeStatusByEnvironmentId.get(host.environmentId))
  )
}

/**
 * A press may only switch to an awake workspace on a ready host from the terminal view. Waking
 * agents or terminals, booting a host, reconnecting SSH or leaving another view waits for the
 * click, since a press can still become a drag.
 */
export function canActivateWorktreeOnPress(args: {
  worktreeId: string
  /** The row's own host, so folder workspaces and host twins resolve to the host they run on. */
  rowHostId: ExecutionHostId | undefined
  isSshDisconnected: boolean
}): boolean {
  const state = useAppStore.getState()
  return (
    state.activeView === 'terminal' &&
    !args.isSshDisconnected &&
    isHostReadyForPress(state, args.rowHostId ?? workspaceOwnerHostId(state, args.worktreeId)) &&
    !hasWorktreeSleepIntent(args.worktreeId) &&
    !workspaceHasSleepingAgentSessions(state, args.worktreeId) &&
    !selectIsSleepingWorktree(state, args.worktreeId)
  )
}
