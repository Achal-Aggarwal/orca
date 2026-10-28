import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatTerminalTextInputs } from './native-chat-terminal-text-inputs'
import type { NativeChatTerminalTextInput } from '../../shared/native-chat-terminal-text-input'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) }
})
let directory: string | undefined
async function fixture() {
  directory = await fs.mkdtemp(join(tmpdir(), 'orca-terminal-text-'))
  return { root: directory, owner: new NativeChatTerminalTextInputs(directory) }
}
function request(): NativeChatTerminalTextInput {
  const id = randomUUID()
  return {
    requestId: randomUUID(),
    scopeKey: 'tab:pane',
    ptyId: 'pty',
    input: `before [Pasted text](orca-paste:${id}) after`,
    sources: [{ id, text: 'x'.repeat(100 * 1024) }]
  }
}
afterEach(async () => {
  vi.mocked(fs.rename).mockRestore()
  vi.mocked(fs.unlink).mockRestore()
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

it('publishes exact requested input before exposing paths, deduplicates preparation, and survives lost replies/reopen', async () => {
  const { owner, root } = await fixture()
  const input = request()
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith(`${input.sources[0]!.id}.txt`)) {
      const inventory = JSON.parse(
        await fs.readFile(join(root, 'pending', input.requestId, 'input.json'), 'utf8')
      )
      expect(inventory).toMatchObject({
        input: input.input,
        ptyId: 'pty',
        scopeKey: 'tab:pane',
        sourceIds: [input.sources[0]!.id]
      })
    }
    // Mock's original implementation is retained below to avoid intercepting itself.
    return rename(from, to)
  })
  const first = owner.materialize(input)
  expect(owner.materialize(input)).toBe(first)
  const paths = await first
  expect(await fs.readFile(paths[input.sources[0]!.id]!, 'utf8')).toBe(input.sources[0]!.text)
  expect(await fs.readdir(join(root, 'pending'))).toEqual([])
  const reopened = new NativeChatTerminalTextInputs(root)
  await reopened.sweep()
  expect(await reopened.materialize(input)).toEqual(paths)
  await expect(reopened.materialize({ ...input, input: 'different request' })).rejects.toThrow(
    'identity changed'
  )
  await expect(reopened.retire({ ...input, scopeKey: 'other' })).rejects.toThrow('owner changed')
  await reopened.retire(input)
  await reopened.sweep()
  await expect(fs.readFile(paths[input.sources[0]!.id]!)).rejects.toMatchObject({ code: 'ENOENT' })
})

// Retain the actual syscalls to exercise inventory recovery while injecting individual failure boundaries.
const { rename, unlink } = await vi.importActual<typeof fs>('node:fs/promises')

it.each(['partial', 'renamed', 'publication', 'published'] as const)(
  'recovers %s crash boundary and retries failed unlink without starving later input',
  async (boundary) => {
    const { owner, root } = await fixture()
    const input = request()
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      const finalFile = String(to).endsWith('.txt')
      const publication = String(to) === join(root, 'published', input.requestId)
      if (boundary === 'partial' && finalFile) {
        throw new Error('write interrupted')
      }
      if (boundary === 'publication' && publication) {
        throw new Error('publication refused')
      }
      await rename(from, to)
      if ((boundary === 'renamed' && finalFile) || (boundary === 'published' && publication)) {
        throw new Error('reply lost')
      }
    })
    await expect(owner.materialize(input)).rejects.toThrow()
    const reopened = new NativeChatTerminalTextInputs(root)
    vi.mocked(fs.rename).mockImplementation(rename)
    if (boundary === 'published') {
      await reopened.sweep()
      const paths = await reopened.materialize(input)
      expect(await fs.readFile(paths[input.sources[0]!.id]!, 'utf8')).toBe(input.sources[0]!.text)
    } else {
      const other = request()
      const paths = await reopened.materialize(other)
      await reopened.retire(other)
      vi.mocked(fs.unlink).mockImplementation(async (path) => {
        if (String(path).includes(input.requestId)) {
          throw new Error('busy')
        }
        return unlink(path)
      })
      await reopened.sweep()
      expect(await fs.readdir(join(root, 'pending'))).toEqual([input.requestId])
      await expect(fs.readFile(paths[other.sources[0]!.id]!)).rejects.toThrow()
      vi.mocked(fs.unlink).mockImplementation(unlink)
      await reopened.sweep()
      expect(await fs.readdir(join(root, 'pending'))).toEqual([])
    }
  }
)

it.each([100 * 1024, 1024 * 1024])(
  'bounds host materialization and recovery work at %i bytes for N/10N inputs',
  async (bytes) => {
    const { owner, root } = await fixture()
    const measurements: unknown[] = []
    for (const count of [1, 10]) {
      vi.mocked(fs.rename).mockClear()
      vi.mocked(fs.unlink).mockClear()
      const started = performance.now()
      for (let i = 0; i < count; i++) {
        const input = request()
        input.sources[0]!.text = 'x'.repeat(bytes)
        const preparation = owner.materialize(input)
        expect(owner.materialize(input)).toBe(preparation)
        const paths = await preparation
        expect((await fs.stat(paths[input.sources[0]!.id]!)).size).toBe(bytes)
        await owner.retire(input)
      }
      await new NativeChatTerminalTextInputs(root).sweep()
      expect(await fs.readdir(join(root, 'pending'))).toEqual([])
      expect(await fs.readdir(join(root, 'published'))).toEqual([])
      expect(fs.rename).toHaveBeenCalledTimes(4 * count)
      expect(fs.unlink).toHaveBeenCalledTimes(4 * count)
      measurements.push({
        bytes,
        count,
        elapsedMs: performance.now() - started,
        renames: 4 * count,
        unlinkAttempts: 4 * count,
        reclaimedBytes: bytes * count
      })
    }
    process.stdout.write(`terminal-paste-host-benchmark ${JSON.stringify(measurements)}\n`)
  }
)
