import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import type { WorkerThreadChildProcess } from '../../worker-thread-child-process/worker-thread-child-process'

/** A second, passive stderr listener: execFile still captures every byte. */
export function observeStderr(
  child: ChildProcessHandle | WorkerThreadChildProcess,
  observer: (chunk: string) => void
): void {
  const onData = (chunk: string | Buffer): void => {
    try {
      observer(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    } catch (error) {
      // Detach throwing observers so stream callbacks cannot crash main.
      child.stderr?.off('data', onData)
      console.warn('git stderr observer failed; detaching it', error)
    }
  }
  child.stderr?.on('data', onData)
}
