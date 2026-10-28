import { useAppStore } from '@/store'
import { workspaceHasSleepingAgentSessions } from '@/lib/worktree-agent-activation-gate'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { selectIsSleepingWorktree } from './use-worktree-sleep-state'

/**
 * A press may only switch to an awake workspace from the terminal view. Waking agents or terminals,
 * resuming a VM, reconnecting SSH or leaving another view waits for the click, since a press can still become a drag.
 */
export function canActivateWorktreeOnPress(
  worktreeId: string,
  isSshDisconnected: boolean
): boolean {
  const state = useAppStore.getState()
  return (
    state.activeView === 'terminal' &&
    !isSshDisconnected &&
    !hasWorktreeSleepIntent(worktreeId) &&
    !workspaceHasSleepingAgentSessions(state, worktreeId) &&
    !selectIsSleepingWorktree(state, worktreeId)
  )
}
