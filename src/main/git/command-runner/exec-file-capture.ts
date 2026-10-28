import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { endSubprocessStdin } from '../../../shared/subprocess-stdin-write'
import type { WslProcessGroupTermination } from '../wsl-process-group-termination'
import { createAbortError } from './abort-error'
import { captureWithRunProcess, emptyExecFileOutput } from './run-process-capture'
import { observeStderr } from './observe-captured-stderr'
import { killSpawnedCommandTree } from './spawned-command-tree-kill'
import { DEFAULT_GIT_MAX_BUFFER } from './git-exec-options'
import type { GitAdmissionTier } from './git-exec-options'
import { workerExecFile } from './worker-exec-file'
import type { WorkerThreadChildProcess } from '../../worker-thread-child-process/worker-thread-child-process'

export type ExecFileCaptureOptions = Omit<ExecFileOptions, 'timeout'> & {
  timeout?: number
  stdin?: string
  terminationBarrier?: boolean
  onChildTerminated?: () => void
  admissionTier?: GitAdmissionTier
  createTimeoutError?: () => Error
  /** Called once when the deadline — not an abort — is what ended the process. */
  onDeadlineKill?: () => void
  onStderr?: (chunk: string) => void
  spawnOnWorkerThread?: boolean
}

export function execFileCaptureToTermination(
  command: string,
  args: string[],
  // Why: runProcess owns this child's streams; git-exec-file refuses onStderr with a barrier.
  options: Omit<ExecFileCaptureOptions, 'onStderr'>,
  termination?: WslProcessGroupTermination
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  return captureWithRunProcess(command, args, options, termination)
}

function isExecFileResultObject(
  value: unknown
): value is { stdout: string | Buffer; stderr: string | Buffer } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Buffer.isBuffer(value) &&
    'stdout' in value &&
    'stderr' in value
  )
}

export function execFileCapture(
  command: string,
  args: string[],
  options: ExecFileCaptureOptions
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  if (
    process.platform !== 'win32' &&
    !(options.spawnOnWorkerThread === true && process.platform === 'darwin')
  ) {
    return captureWithRunProcess(command, args, options, undefined, true)
  }
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      options.onChildTerminated?.()
      reject(createAbortError())
      return
    }

    let settled = false
    let terminating = false
    let child: ChildProcess | WorkerThreadChildProcess | null = null
    const useWorker = options.spawnOnWorkerThread === true && process.platform === 'darwin'
    let timer: NodeJS.Timeout | null = null
    let terminationReported = false
    const reportChildTerminated = (): void => {
      if (terminationReported) {
        return
      }
      terminationReported = true
      options.onChildTerminated?.()
    }
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (
      error: Error | null,
      stdout: string | Buffer = emptyExecFileOutput(options),
      stderr: string | Buffer = emptyExecFileOutput(options)
    ): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error) {
        const enriched = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer }
        enriched.stdout ??= stdout
        enriched.stderr ??= stderr
        reject(enriched)
        return
      }
      resolve({ stdout, stderr })
    }
    const onAbort = (): void => {
      if (settled || terminating) {
        return
      }
      terminating = true
      const abortError = createAbortError()
      if (!child) {
        terminating = false
        finish(abortError)
        return
      }
      void killSpawnedCommandTree(child).then(() => {
        terminating = false
        finish(abortError)
      })
    }

    try {
      const spawnStartedAt = performance.now()
      // Why: our abort listener owns tree cleanup; Node's signal handler could kill wsl.exe before taskkill sees its children.
      const capture = useWorker ? workerExecFile : execFile
      child = capture(
        command,
        args,
        {
          cwd: options.cwd,
          // Hide console-subsystem children so frequent Git calls cannot flash or take focus.
          windowsHide: true,
          encoding: options.encoding,
          maxBuffer: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
          env: options.env
        },
        (error, stdout, stderr) => {
          if (terminating) {
            return
          }
          if (!error && stderr === undefined && isExecFileResultObject(stdout)) {
            finish(null, stdout.stdout, stdout.stderr)
            return
          }
          finish(error, stdout, stderr)
        }
      )
      recordSubprocessSpawn(command, args, performance.now() - spawnStartedAt)
    } catch (error) {
      reportChildTerminated()
      finish(error instanceof Error ? error : new Error(String(error)))
      return
    }

    child.once('error', (error) => {
      // A lost worker may have spawned a child whose PID never reached us; only close proves termination.
      if (!useWorker && !child?.pid) {
        reportChildTerminated()
      }
      if (!terminating) {
        finish(error)
      }
    })
    child.once('close', reportChildTerminated)
    if (options.onStderr) {
      observeStderr(child, options.onStderr)
    }

    // Non-interactive signers must see EOF instead of waiting on an open pipe.
    if ('id' in child) {
      if (options.stdin !== undefined) {
        child.stdin.write(options.stdin)
      }
      child.stdin.end()
    } else {
      endSubprocessStdin(child.stdin, options.stdin ?? '')
    }

    // Why: Node's timeout waits forever on signal-ignoring CLIs; enforce our own deadline with bounded tree cleanup.
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        if (settled || terminating) {
          return
        }
        terminating = true
        const timeoutError = options.createTimeoutError?.() ?? new Error(`${command} timed out.`)
        if (!child) {
          terminating = false
          finish(timeoutError)
          return
        }
        void killSpawnedCommandTree(child).then(() => {
          terminating = false
          finish(timeoutError)
        })
      }, options.timeout)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
