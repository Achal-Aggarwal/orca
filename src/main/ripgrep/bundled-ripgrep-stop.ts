import { signalProcessTree } from '@orca/process-host/process-tree-termination'
import {
  absorbRipgrepTerminationError,
  killSpawnedRipgrepProcess
} from '../../shared/ripgrep-process-availability'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'

const stoppingChildren = new WeakSet<ChildProcessHandle>()

export function stopBundledRipgrep(child: ChildProcessHandle, wsl = false): void {
  if (stoppingChildren.has(child)) {
    return
  }
  stoppingChildren.add(child)
  if (process.platform === 'win32' && wsl && child.pid !== undefined) {
    absorbRipgrepTerminationError(child)
    try {
      void signalProcessTree(child).catch(() => killSpawnedRipgrepProcess(child))
      return
    } catch {
      // A failed tree signal still needs the existing root-process fallback.
    }
  }
  killSpawnedRipgrepProcess(child)
}
