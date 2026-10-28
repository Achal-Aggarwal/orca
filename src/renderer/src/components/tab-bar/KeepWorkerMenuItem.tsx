import { Lock } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { useAppStore } from '../../store'

/** Orca closes a finished worker's terminal on its own; this keeps it, like worker-retain. */
export function KeepWorkerMenuItem({
  tabId,
  worktreeId
}: {
  tabId: string
  worktreeId: string
}): React.JSX.Element | null {
  // Joined so the selector returns a stable primitive across unrelated store updates.
  const workerPaneKeys = useAppStore((state) =>
    Object.keys(state.runtimeAgentOrchestrationByPaneKey)
      .filter((paneKey) => parsePaneKey(paneKey)?.tabId === tabId)
      .join('\n')
  )
  if (!workerPaneKeys) {
    return null
  }

  const keepWorker = async (): Promise<void> => {
    const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), worktreeId)
    const target =
      environmentId !== null
        ? { kind: 'environment' as const, environmentId }
        : { kind: 'local' as const }
    try {
      const results = await Promise.all(
        workerPaneKeys.split('\n').map((paneKey) =>
          callRuntimeRpc<{ changed: number }>(target, 'orchestration.workerTerminalUserKeep', {
            paneKey
          })
        )
      )
      if (results.some((result) => result.changed > 0)) {
        toast.success(translate('components.tab.bar.KeepWorkerMenuItem.kept', 'Worker kept open'))
      } else {
        toast.info(
          translate(
            'components.tab.bar.KeepWorkerMenuItem.nothingToKeep',
            'Nothing to keep for this terminal'
          )
        )
      }
    } catch {
      toast.error(
        translate('components.tab.bar.KeepWorkerMenuItem.failed', 'Could not keep this worker open')
      )
    }
  }

  return (
    <DropdownMenuItem onSelect={() => void keepWorker()}>
      <Lock className="size-3.5 shrink-0" />
      {translate('components.tab.bar.KeepWorkerMenuItem.keep', 'Keep Worker Open')}
    </DropdownMenuItem>
  )
}
