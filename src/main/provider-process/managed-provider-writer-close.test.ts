import { afterEach, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { createClaudeChildTreeReaper } from '../claude/claude-agent-sdk-exit-proof'
import { claudeChildCloseProven } from '../claude/claude-child-exit-proof-ladder'
import { spawnManagedProviderProcess } from './managed-provider-process'

const taskkill = vi.hoisted(() => vi.fn(async () => false))
vi.mock('../windows-process-tree-kill', () => ({ terminateWindowsProcessTree: taskkill }))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  taskkill.mockReset()
})

function fixture(strict = false) {
  const child = createFakePipedChild(424242)
  vi.spyOn(child, 'kill').mockReturnValue(true)
  const managed = spawnManagedProviderProcess(
    { command: 'fixture', args: [] },
    {
      spawnImpl: () => child,
      platform: 'win32',
      site: 'fixture',
      policy: () => ({ gracefulExitMs: 10, forcedExitMs: 5 }),
      ...(strict ? { acceptClose: claudeChildCloseProven } : {})
    }
  )
  return { child, managed }
}

it('caches delivered writer close without a second ladder and isolates its replacement', async () => {
  vi.useFakeTimers()
  taskkill.mockResolvedValueOnce(true)
  const { managed } = fixture()
  const first = managed.close()
  await vi.advanceTimersByTimeAsync(15)
  expect(await first).toEqual({ root: 'live', tree: 'exited', killDelivered: true })
  expect(managed.close()).toBe(first)
  expect(taskkill).toHaveBeenCalledTimes(1)
  const replacement = fixture().managed
  const next = replacement.close()
  await vi.advanceTimersByTimeAsync(15)
  expect(await next).not.toHaveProperty('killDelivered')
  expect(taskkill).toHaveBeenCalledTimes(2)
})

it('retries every undelivered close until an actual exit', async () => {
  vi.useFakeTimers()
  const { managed, child } = fixture()
  for (let index = 0; index < 3; index++) {
    const attempt = managed.close()
    await vi.advanceTimersByTimeAsync(15)
    expect(await attempt).toEqual({ root: 'live', tree: 'unverifiable' })
  }
  expect(taskkill).toHaveBeenCalledTimes(3)
  child.emit('exit', 0, null)
  await expect(managed.close()).resolves.toMatchObject({ root: 'exited' })
})

it('retains irreversible delivery through explicit strict cleanup retries without delaying writer joins', async () => {
  vi.useFakeTimers()
  const { managed, child } = fixture(true)
  const kill = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
  const tree = createClaudeChildTreeReaper(child, { platform: 'win32', terminateWindowsTree: kill })
  const first = managed.close(tree)
  await vi.advanceTimersByTimeAsync(15)
  expect(await first).toMatchObject({ root: 'live', killDelivered: true })
  const retry = managed.close(tree)
  const writer = managed.closeWriter(tree)
  await expect(writer).resolves.toMatchObject({ root: 'live', killDelivered: true })
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(15)
  expect(await retry).toMatchObject({ root: 'live', killDelivered: true })
  expect(kill).toHaveBeenCalledTimes(2)
  expect(claudeChildCloseProven(await retry)).toBe(false)
  child.emit('exit', 0, null)
  await expect(managed.close(tree)).resolves.toMatchObject({ root: 'exited', killDelivered: true })
  await expect(managed.closeWriter(tree)).resolves.toMatchObject({
    root: 'exited',
    killDelivered: true
  })
  expect(kill).toHaveBeenCalledTimes(2)
})

it('derives prior background reaper delivery before the first managed writer close', async () => {
  const { managed, child } = fixture(true)
  const terminateWindowsTree = vi.fn(async () => true)
  const tree = createClaudeChildTreeReaper(child, { platform: 'win32', terminateWindowsTree })
  await tree.reap()
  expect(managed.lastCloseResult).toBeNull()
  await expect(managed.closeWriter(tree)).resolves.toEqual({
    root: 'live',
    tree: 'exited',
    killDelivered: true
  })
  expect(terminateWindowsTree).toHaveBeenCalledOnce()
  expect(taskkill).not.toHaveBeenCalled()
})
