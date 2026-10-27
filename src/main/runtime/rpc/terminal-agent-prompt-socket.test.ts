import './unused-default-rpc-methods.test-fixture'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { UnixSocketTransport } from './unix-socket-transport'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import { TERMINAL_METHODS } from './methods/terminal'
import { STATUS_METHODS } from './methods/status'
import { OrchestrationDb } from '../orchestration/db'
import { writePtyFromRuntimeController } from '../../ipc/pty/runtime/operations'
import { getLocalPtyProvider, setLocalPtyProvider } from '../../ipc/pty/provider/registry'
import type { IPtyProvider } from '../../providers/pty-provider-contract'

vi.mock('../../git/worktree', () => {
  const read = async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'prompt', isBare: false, isMainWorktree: false }
  ]
  return { listWorktrees: read, listWorktreesStrict: read }
})

it.each(['before', 'after'] as const)(
  'real CLI close %s paste finishes admitted input and drops a cancelled follower',
  async (boundary) => {
    const latch = () => Promise.withResolvers<void>()
    const pasted = latch(),
      release = latch(),
      closed = latch(),
      received = latch()
    const root = mkdtempSync(join(tmpdir(), 'orca-prompt-socket-'))
    const kind = process.platform === 'win32' ? 'named-pipe' : 'unix'
    const endpoint =
      kind === 'named-pipe' ? `\\\\.\\pipe\\${root.split(/[/\\]/).at(-1)}` : join(root, 'rpc')
    const transport = new UnixSocketTransport({ endpoint, kind })
    const prior = getLocalPtyProvider()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test's controller uses only provider.write.
    setLocalPtyProvider({ write: () => true } as IPtyProvider)
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => pasted.resolve(),
      'claude',
      (host, id, data) => writePtyFromRuntimeController({ runtime: host }, id, data, 'driving')
    )
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [...STATUS_METHODS, ...TERMINAL_METHODS]
    })
    Object.defineProperty(runtime, 'createAgentPromptRenderGate', {
      value: () => ({ arm: () => {}, wait: () => release.promise, dispose: () => {} })
    })
    const done: Promise<unknown>[] = []
    let promptRequest: RpcRequest | undefined
    transport.onMessage((raw, reply, context) => {
      const request: RpcRequest = JSON.parse(raw)
      const prompt = request.method === 'terminal.send'
      if (prompt) {
        promptRequest = request
        received.resolve()
        context!.signal.addEventListener('abort', () => closed.resolve(), { once: true })
      }
      done.push(
        (async () => {
          await (prompt && boundary === 'before' ? release.promise : Promise.resolve())
          reply(JSON.stringify(await dispatcher.dispatch(request, context)))
        })()
      )
    })
    await transport.start()
    writeFileSync(
      join(root, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: runtime.getRuntimeId(),
        pid: process.pid,
        startedAt: 1,
        authToken: 'fixture-token',
        transports: [{ kind, endpoint }]
      })
    )
    const preload = join(root, 'exit-on-input.ts')
    writeFileSync(preload, "process.stdin.once('data', () => process.exit(0))")
    const manifest = createRequire(resolve('package.json')).resolve('bun/package.json')
    const { bin } = z
      .object({ bin: z.object({ bun: z.string() }) })
      .parse(JSON.parse(readFileSync(manifest, 'utf8')))
    const env = {
      ...Object.fromEntries(
        'HOME USERPROFILE APPDATA LOCALAPPDATA XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME ORCA_E2E_HOME_DIR ORCA_E2E_USER_DATA_DIR ORCA_USER_DATA_PATH TEMP TMP TMPDIR'
          .split(' ')
          .map((key) => [key, root])
      ),
      CODEX_HOME: join(root, 'codex'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot
    }
    const args = ['terminal', 'send', '--terminal', handle, '--text', 'first', '--enter', '--json']
    const child = spawn(
      join(dirname(manifest), bin.bun),
      ['--preload', preload, resolve('src/cli/index.ts'), ...args],
      { cwd: root, env, stdio: 'pipe' }
    )
    const exited = once(child, 'close')
    child.stderr.resume()
    try {
      await Promise.race([
        received.promise,
        exited.then(() => {
          throw new Error('CLI exited before sending')
        })
      ])
      await (boundary === 'after' ? pasted.promise : received.promise)
      child.stdin.end('exit') // The test-owned child exits itself; no process-tree termination.
      await exited
      await closed.promise
      const secondObserver = new AbortController()
      const second = runtime.sendTerminalAgentPrompt(handle, 'second', {
        inputKind: 'driving',
        observationSignal: secondObserver.signal
      })
      void second.catch(() => undefined)
      secondObserver.abort()
      release.resolve()
      await Promise.all(done)
      await expect(second).rejects.toThrow('request_aborted')
      expect(writes).toEqual(boundary === 'after' ? [expect.stringContaining('first'), '\r'] : [])
      if (boundary === 'after') {
        const replay = await dispatcher.dispatch(promptRequest!)
        expect(replay.ok && replay.result).toMatchObject({
          send: { prompt: { stages: ['input_accepted'] } }
        })
        expect(writes).toHaveLength(2)
      }
    } finally {
      release.resolve()
      if (child.exitCode === null) {
        child.stdin.end('exit')
      }
      await exited
      await transport.stop()
      await Promise.allSettled(done)
      db.close()
      setLocalPtyProvider(prior)
      rmSync(root, { recursive: true, force: true })
    }
  },
  20_000
)
