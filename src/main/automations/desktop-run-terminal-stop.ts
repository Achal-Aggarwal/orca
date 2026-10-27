import type { BrowserWindow, WebContents } from 'electron'
import { addFanoutListener, addFanoutListeners } from '../event-listener-fanout'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

// Ordinary Stop revokes the same registration, including a pending provider authorization.
export const stopRevokers = new Map<string, { ptyId: string | null; release: () => void }>()
export function cancelDesktopTerminalRetirement(ptyId: string): void {
  for (const owner of stopRevokers.values()) {
    if (owner.ptyId === ptyId) {
      owner.release()
    }
  }
}

export async function stopDesktopRunTerminal(
  runtime: OrcaRuntimeService,
  worktreeId: string,
  expectedPtyId: string,
  expectedIncarnationId: string,
  authorizeStop: () => Promise<boolean>
): Promise<'stopped' | 'live' | 'unproven'> {
  let dispatched = false
  let proof: 'stopped' | 'live' | 'unproven' = 'live'
  try {
    const stopped = await runtime.stopExactTerminalsForWorktree(
      `id:${worktreeId}`,
      [expectedPtyId],
      {
        keepHistory: true,
        targetOnly: true,
        expectedIncarnationId,
        authorizeStop: async () => {
          dispatched = await authorizeStop()
          return dispatched
        }
      }
    )
    proof =
      stopped.postStopVerified && stopped.stoppedPtyIds.includes(expectedPtyId)
        ? 'stopped'
        : 'unproven'
  } catch {
    proof = 'live'
    if (dispatched) {
      proof = 'unproven'
      try {
        const inventory = await runtime.listTerminals(`id:${worktreeId}`, 1000, {
          requireFreshPtyLiveness: true
        })
        if (
          inventory.terminals.some(
            (entry) =>
              entry.ptyId === expectedPtyId &&
              entry.incarnationId === expectedIncarnationId &&
              entry.connected
          )
        ) {
          proof = 'live'
        }
      } catch {
        /* Unavailable inventory cannot prove a live rollback. */
      }
    }
  }

  return proof
}

export function watchDesktopTerminalStop(
  window: BrowserWindow,
  web: WebContents,
  release: () => void
): (() => void)[] {
  return [
    addFanoutListener(window, 'closed', release),
    addFanoutListeners(web, ['destroyed', 'render-process-gone'], release),
    addFanoutListener(
      web,
      'did-start-navigation',
      (_event: unknown, _url: string, sameDocument: boolean, mainFrame: boolean) => {
        if (mainFrame && !sameDocument) {
          release()
        }
      }
    )
  ]
}
