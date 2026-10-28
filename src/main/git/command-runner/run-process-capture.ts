import { fileURLToPath } from 'node:url'
import { runProcess } from '@orca/process-host'
import { resolveSelectedLocalCommand } from '../../ipc/command-path-resolver'
import type { WslProcessGroupTermination } from '../wsl-process-group-termination'
import { createAbortError } from './abort-error'
import { DEFAULT_GIT_MAX_BUFFER } from './git-exec-options'
import type { ExecFileCaptureOptions } from './exec-file-capture'

const GIT_TERMINATION_BARRIER_FALLBACK_TIMEOUT_MS = 2_147_000_000

export async function captureWithRunProcess(
  command: string,
  args: string[],
  options: ExecFileCaptureOptions,
  termination?: WslProcessGroupTermination,
  ownedProcessGroup = false
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  if (ownedProcessGroup && options.signal?.aborted) {
    options.onChildTerminated?.()
    throw createAbortError()
  }
  // runProcess already reports spawn cost through spawnProcess.
  let cwd: string | undefined
  let program: string
  try {
    cwd =
      typeof options.cwd === 'string' || options.cwd === undefined
        ? options.cwd
        : fileURLToPath(options.cwd)
    program = resolveSelectedLocalCommand(command, {
      env: options.env,
      cwd
    })
  } catch (error) {
    options.onChildTerminated?.()
    if (ownedProcessGroup && error instanceof Error) {
      Object.assign(error, {
        stdout: emptyExecFileOutput(options),
        stderr: emptyExecFileOutput(options)
      })
    }
    throw error
  }
  const encoding = options.encoding === null ? 'buffer' : (options.encoding ?? 'utf8')
  if (encoding !== 'buffer' && !Buffer.isEncoding(encoding)) {
    options.onChildTerminated?.()
    throw new TypeError(`Unsupported Git output encoding: ${encoding}`)
  }
  let stderrObserver = options.onStderr
  const pending = runProcess({
    program,
    args,
    cwd,
    env: options.env,
    timeoutMs: ownedProcessGroup
      ? options.timeout && options.timeout > 0
        ? options.timeout
        : null
      : (options.timeout ?? GIT_TERMINATION_BARRIER_FALLBACK_TIMEOUT_MS),
    maxOutputBytes: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
    captureStdoutAsBytes: true,
    captureStderrAsBytes: true,
    killOnOutputLimit: ownedProcessGroup,
    signal: options.signal,
    terminationBarrier: termination ?? true,
    ownedProcessGroup,
    onChildTerminated: options.onChildTerminated,
    onStderr: (chunk) => {
      try {
        stderrObserver?.(chunk.toString())
      } catch (error) {
        stderrObserver = undefined
        console.warn('git stderr observer failed; detaching it', error)
      }
    },
    ...(options.stdin === undefined ? {} : { input: options.stdin })
  })
  const result = await pending.catch((error: unknown) => {
    if (error instanceof Error) {
      throw Object.assign(error, {
        stdout: 'stdout' in error ? error.stdout : emptyExecFileOutput(options),
        stderr: 'stderr' in error ? error.stderr : emptyExecFileOutput(options)
      })
    }
    throw error
  })
  const stdoutBytes = result.stdoutBytes ?? Buffer.alloc(0)
  const rawStderr = result.stderrBytes ?? Buffer.alloc(0)
  const stderrBytes = termination
    ? Buffer.from(termination.stripControlOutput(rawStderr.toString('latin1')), 'latin1')
    : rawStderr
  const stdout = encoding === 'buffer' ? stdoutBytes : stdoutBytes.toString(encoding)
  const stderr = encoding === 'buffer' ? stderrBytes : stderrBytes.toString(encoding)
  if (
    result.code === 0 &&
    !result.timedOut &&
    !result.outputTruncated &&
    !options.signal?.aborted
  ) {
    return { stdout, stderr }
  }
  if (result.timedOut && !options.signal?.aborted) {
    options.onDeadlineKill?.()
  }
  const cleanStderr = typeof stderr === 'string' ? stderr : stderr.toString('utf8')
  const error = result.timedOut
    ? (options.createTimeoutError?.() ?? new Error(`${command} timed out.`))
    : new Error(
        options.signal?.aborted
          ? 'The operation was aborted.'
          : result.outputTruncated
            ? // Reject clipped output: JSON/JSONL consumers could otherwise accept an incomplete result.
              `${command} produced more than ${options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER} bytes of output.`
            : cleanStderr.trim() || `${command} exited with ${result.code}.`
      )
  if (options.signal?.aborted) {
    error.name = 'AbortError'
  }
  throw Object.assign(error, {
    code:
      ownedProcessGroup && result.outputTruncated
        ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        : result.code,
    killed:
      (ownedProcessGroup && result.outputTruncated) ||
      result.timedOut ||
      result.signal !== null ||
      options.signal?.aborted === true,
    signal: result.signal,
    outputTruncated: result.outputTruncated,
    stdout,
    stderr
  })
}

export function emptyExecFileOutput(options: ExecFileCaptureOptions): string | Buffer {
  return options.encoding === 'buffer' || options.encoding === null ? Buffer.alloc(0) : ''
}
