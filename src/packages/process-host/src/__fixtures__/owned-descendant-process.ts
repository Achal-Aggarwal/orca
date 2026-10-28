import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export async function writeOwnedDescendantProcess(directory: string, exitOnReady = false) {
  const script = join(directory, 'root.cjs')
  const pidFile = join(directory, 'descendant.pid')
  const descendant =
    `process.on('SIGTERM', () => {});` +
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
    `process.send('ready');` +
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);`
  const ready = exitOnReady
    ? `process.exit(0);`
    : `process.stdout.write('x'.repeat(1024));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);`
  await writeFile(
    script,
    `const {spawn} = require('node:child_process');const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});child.on('message', () => {${ready}});`
  )
  const pid = async (): Promise<number> => Number(await readFile(pidFile, 'utf8'))
  return {
    script,
    pidFile,
    async running(): Promise<boolean> {
      const id = await pid().catch(() => 0)
      if (!id) {
        return false
      }
      const status = await execute('ps', ['-p', String(id), '-o', 'stat=']).catch(() => null)
      return Boolean(status?.stdout.trim() && !status.stdout.trim().startsWith('Z'))
    },
    async dispose(): Promise<void> {
      const id = await pid().catch(() => 0)
      if (id) {
        try {
          process.kill(id, 'SIGKILL')
        } catch {}
      }
    }
  }
}
