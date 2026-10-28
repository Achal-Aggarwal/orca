import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from './run-process'
import { ownedPosixProcessGroup } from './owned-posix-process-group'
import * as treeTermination from './process-tree-termination'
import { writeOwnedDescendantProcess } from './__fixtures__/owned-descendant-process'

const node = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath

describe.skipIf(process.platform === 'win32')('owned POSIX process groups', () => {
  it('finishes ordinary natural close without starting tree cleanup', async () => {
    const signal = vi.spyOn(treeTermination, 'signalProcessTree')
    const force = vi.spyOn(treeTermination, 'forceTerminateProcessTree')
    try {
      await expect(
        runProcess({
          program: node,
          args: ['-e', 'process.stdout.write("complete")'],
          ownedProcessGroup: true
        })
      ).resolves.toMatchObject({ code: 0, stdout: 'complete', timedOut: false })
      expect(signal).not.toHaveBeenCalled()
      expect(force).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('keeps escalation after natural root close while a redirected descendant ignores SIGTERM', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-owned-group-'))
    const fixture = await writeOwnedDescendantProcess(directory, true)
    const child = spawnProcess({ program: node, args: [fixture.script], ownedProcessGroup: true })
    const owner = ownedPosixProcessGroup(child)
    if (!owner) {
      throw new Error('Missing process-group owner')
    }
    let terminated = false
    void owner.terminated.then(() => {
      terminated = true
    })
    try {
      await once(child, 'close')
      expect(await fixture.running()).toBe(true)
      expect(terminated).toBe(false)
      await owner.terminated
      expect(await fixture.running()).toBe(false)
    } finally {
      await owner.stop('SIGKILL')
      await fixture.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stops a live descendant when bounded capture overflows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-owned-capture-'))
    const fixture = await writeOwnedDescendantProcess(directory)
    try {
      const result = await runProcess({
        program: node,
        args: [fixture.script],
        ownedProcessGroup: true,
        maxOutputBytes: 16,
        killOnOutputLimit: true,
        timeoutMs: 10_000
      })
      expect(result).toMatchObject({ outputTruncated: true, stdout: 'x'.repeat(16) })
      expect(await fixture.running()).toBe(false)
    } finally {
      await fixture.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps a standalone host alive through cleanup after natural root exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-standalone-group-'))
    const fixture = await writeOwnedDescendantProcess(directory, true)
    const host = createRequire(join(process.cwd(), 'package.json')).resolve('@orca/process-host')
    try {
      const result = await runProcess({
        program: node,
        args: [
          '-e',
          `require(${JSON.stringify(host)}).runProcess({program:process.execPath,args:[${JSON.stringify(fixture.script)}],ownedProcessGroup:true}).then(()=>process.stdout.write('terminated'))`
        ],
        timeoutMs: 10_000
      })
      expect(result).toMatchObject({ code: 0, stdout: 'terminated', timedOut: false })
      expect(await fixture.running()).toBe(false)
    } finally {
      await fixture.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
