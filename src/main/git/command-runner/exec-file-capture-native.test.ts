import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileCapture } from './exec-file-capture'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(process.platform === 'win32')('native owned capture compatibility', () => {
  const bytes = Buffer.from([0, 255, 128, 10])
  const script =
    'process.stdout.write(Buffer.from([0,255,128,10]));process.stderr.write(Buffer.from([0,255,128,10]));'

  it.each([undefined, 0, -1])(
    'leaves the execution deadline disabled with timeout %s',
    async (timeout) => {
      const onDeadlineKill = vi.fn()
      await expect(
        execFileCapture(
          process.execPath,
          ['-e', 'setTimeout(()=>process.stdout.write("complete"),20)'],
          { timeout, onDeadlineKill }
        )
      ).resolves.toEqual({ stdout: 'complete', stderr: '' })
      expect(onDeadlineKill).not.toHaveBeenCalled()
    }
  )

  it('rejects a pre-aborted request before resolving or validating its command', async () => {
    const controller = new AbortController()
    controller.abort()
    const onChildTerminated = vi.fn()
    await expect(
      execFileCapture('orca-missing-executable-932846', [], {
        signal: controller.signal,
        cwd: new URL('https://invalid.example/'),
        onChildTerminated
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })

  it('reports a validation failure without leaving the child lifetime open', async () => {
    const onChildTerminated = vi.fn()
    await expect(
      execFileCapture(process.execPath, [], {
        cwd: new URL('https://invalid.example/'),
        encoding: 'buffer',
        onChildTerminated
      })
    ).rejects.toMatchObject({
      code: 'ERR_INVALID_URL_SCHEME',
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0)
    })
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })

  it.each(['buffer', null, 'latin1'] as const)(
    'preserves %s output on success and failure',
    async (encoding) => {
      const output = encoding === 'latin1' ? bytes.toString('latin1') : bytes
      await expect(
        execFileCapture(process.execPath, ['-e', script], { encoding, timeout: 3_000 })
      ).resolves.toEqual({ stdout: output, stderr: output })
      await expect(
        execFileCapture(process.execPath, ['-e', `${script}process.exitCode=7`], {
          encoding,
          timeout: 3_000
        })
      ).rejects.toMatchObject({
        code: 7,
        signal: null,
        killed: false,
        stdout: output,
        stderr: output
      })
    }
  )

  it('keeps capturing stderr after a passive observer throws', async () => {
    const observer = vi.fn(() => {
      throw new Error('observer stopped')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await execFileCapture(
      process.execPath,
      ['-e', 'process.stderr.write("first");setTimeout(()=>process.stderr.write("second"),20)'],
      { onStderr: observer, timeout: 3_000 }
    )
    expect(result).toEqual({ stdout: '', stderr: 'firstsecond' })
    expect(observer).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledOnce()
  })

  it.each(['buffer', null, 'utf8'] as const)(
    'retains spawn failure metadata with %s encoding',
    async (encoding) => {
      const onChildTerminated = vi.fn()
      const empty = encoding === 'utf8' ? '' : Buffer.alloc(0)
      await expect(
        execFileCapture('orca-missing-executable-932846', [], { encoding, onChildTerminated })
      ).rejects.toMatchObject({ code: 'ENOENT', stdout: empty, stderr: empty })
      expect(onChildTerminated).toHaveBeenCalledOnce()
    }
  )
})
