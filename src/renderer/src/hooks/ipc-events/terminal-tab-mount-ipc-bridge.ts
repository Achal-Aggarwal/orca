import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { planMobileTerminalTabMount } from '@/lib/mobile-terminal-tab-mount'
import { useAppStore } from '../../store'

export function registerTerminalTabMountIpcBridge(): () => void {
  return window.api.ui.onRequestTerminalTabMount(({ worktreeId, tabId, ptyId }) => {
    if (!worktreeId) {
      return
    }
    // Why: synthetic pty handles need persisted-tab resolution; a miss must not mount every saved tab in a hidden worktree.
    const mount = planMobileTerminalTabMount(
      useAppStore.getState(),
      {
        worktreeId,
        ...(tabId ? { tabId } : {}),
        ...(ptyId ? { ptyId } : {})
      },
      {
        isTabMounted: (tabId, targetWorktreeId) =>
          hasRegisteredRuntimeTerminalTab(tabId, targetWorktreeId)
      }
    )
    if (mount) {
      requestBackgroundTerminalWorktreeMount(mount)
    }
  })
}
