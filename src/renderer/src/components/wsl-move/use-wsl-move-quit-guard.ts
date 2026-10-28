import { useEffect } from 'react'
import { translate } from '@/i18n/i18n'
import { isIntentionalAppRestartInProgress } from '@/lib/updater-beforeunload'
import type { ConfirmationDialogOptions } from '../confirmation-dialog-context'
import { registerWindowCloseGuard } from '../window-close-request-coordinator'

/**
 * Quitting (or closing the window) mid-move loses the run; the next launch undoes it safely, but
 * the user should choose that. Asks only while main reports a move running.
 */
export async function confirmQuitDuringWslMove(
  isRunning: () => Promise<boolean>,
  confirm: (options: ConfirmationDialogOptions) => Promise<boolean>
): Promise<boolean> {
  if (isIntentionalAppRestartInProgress()) {
    return true
  }
  // Unknown is not running: a failed ask must never trap the user in the app.
  if (!(await isRunning().catch(() => false))) {
    return true
  }
  return confirm({
    title: translate('sidebar.wslMoved.quitDuringMoveTitle', 'Quit while a project is moving?'),
    description: translate(
      'sidebar.wslMoved.quitDuringMoveDescription',
      'A project is moving to its WSL host. Quit anyway? The move will be undone at next launch.'
    ),
    confirmLabel: translate('sidebar.wslMoved.quitDuringMoveConfirm', 'Quit anyway'),
    confirmVariant: 'destructive'
  })
}

export function useWslMoveQuitGuard(
  enabled: boolean,
  confirm: (options: ConfirmationDialogOptions) => Promise<boolean>
): void {
  useEffect(
    () =>
      enabled
        ? registerWindowCloseGuard(() =>
            confirmQuitDuringWslMove(() => window.api.wslMove.isRunning(), confirm)
          )
        : undefined,
    [enabled, confirm]
  )
}
