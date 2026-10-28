const OUTPUT_TAIL_LINES = 200
const HEARTBEAT_MS = 15_000

function elapsed(startedAt) {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`
}

export function outputTail(text) {
  const lines = text.trimEnd().split(/\r?\n/)
  return lines.length <= OUTPUT_TAIL_LINES
    ? lines.join('\n')
    : [
        `… ${lines.length - OUTPUT_TAIL_LINES} earlier lines omitted`,
        ...lines.slice(-OUTPUT_TAIL_LINES)
      ].join('\n')
}

export async function runTask(task, { root, env, runProcess, stepTimeoutMs, signal }) {
  const startedAt = performance.now()
  let output = ''
  for (const [index, { program, args, liveOutput }] of task.steps.entries()) {
    if (signal?.aborted) {
      return { task, ok: false, output: `${output}\nCancelled.`, elapsed: elapsed(startedAt) }
    }
    const command = [program, ...args].map((argument) => JSON.stringify(argument)).join(' ')
    const label = `${task.name} [${index + 1}/${task.steps.length}]`
    console.log(`▶ ${label}: ${command} (deadline ${stepTimeoutMs / 1000}s)`)
    const heartbeat = setInterval(() => {
      console.log(`… ${label} still running (${elapsed(startedAt)} elapsed)`)
    }, HEARTBEAT_MS)
    try {
      const result = await runProcess(
        {
          program,
          args,
          cwd: root,
          env,
          timeoutMs: stepTimeoutMs,
          maxOutputBytes: 256 * 1024,
          signal,
          detached: process.platform !== 'win32',
          terminationBarrier: true,
          ...(liveOutput
            ? {
                stdio: ['ignore', 'inherit', 'pipe'],
                onStderr: (chunk) => process.stderr.write(chunk)
              }
            : {})
        },
        'tail'
      )
      output = outputTail(output + result.stdout + result.stderr)
      if (result.timedOut || signal?.aborted || result.code !== 0) {
        const reason = result.timedOut
          ? `Timed out after ${stepTimeoutMs / 1000}s; increase --stepTimeoutMs=<ms> for a longer run.`
          : signal?.aborted
            ? 'Cancelled.'
            : `Exited with ${result.signal ?? result.code}.`
        return {
          task,
          ok: false,
          output: `${output}\n${reason}\nCommand: ${command}`,
          elapsed: elapsed(startedAt)
        }
      }
    } catch (error) {
      return {
        task,
        ok: false,
        output: `${output}\n${error.message ?? error}\nCommand: ${command}`,
        elapsed: elapsed(startedAt)
      }
    } finally {
      clearInterval(heartbeat)
    }
  }
  console.log(`✓ ${task.name} (${elapsed(startedAt)})`)
  return { task, ok: true, output, elapsed: elapsed(startedAt) }
}

export async function runPool(tasks, concurrency, run) {
  const results = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (next < tasks.length) {
        results.push(await run(tasks[next++]))
      }
    })
  )
  return results
}
