import { afterEach, expect, it, vi } from 'vitest'
import { createMonacoTsProgramIdleRefresh } from './monaco-ts-program-idle-refresh'

afterEach(() => vi.useRealTimers())

it('does no periodic work and coalesces retirements until the worker is idle', async () => {
  vi.useFakeTimers()
  const refresh = vi.fn()
  const idle = createMonacoTsProgramIdleRefresh(refresh, 100)
  await vi.advanceTimersByTimeAsync(1000)
  expect(refresh).not.toHaveBeenCalled()
  idle.retired()
  await vi.advanceTimersByTimeAsync(50)
  idle.retired()
  await vi.advanceTimersByTimeAsync(50)
  expect(refresh).not.toHaveBeenCalled()
  idle.activity()
  await vi.advanceTimersByTimeAsync(99)
  expect(refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('waits for every overlapping request, including rejected requests', async () => {
  vi.useFakeTimers()
  const refresh = vi.fn()
  const idle = createMonacoTsProgramIdleRefresh(refresh, 100)
  let resolve: (value: number) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const first = idle.request(
    () =>
      new Promise<number>((done) => {
        resolve = done
      })
  )
  const second = idle.request(
    () =>
      new Promise<number>((_done, fail) => {
        reject = fail
      })
  )
  const rejected = expect(second).rejects.toThrow('failed')
  idle.retired()
  await vi.advanceTimersByTimeAsync(1000)
  expect(vi.getTimerCount()).toBe(0)
  resolve(7)
  expect(await first).toBe(7)
  await vi.advanceTimersByTimeAsync(1000)
  expect(refresh).not.toHaveBeenCalled()
  reject(new Error('failed'))
  await rejected
  await vi.advanceTimersByTimeAsync(99)
  expect(refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('postpones an idle retirement when a request starts and handles synchronous failure', async () => {
  vi.useFakeTimers()
  const refresh = vi.fn()
  const idle = createMonacoTsProgramIdleRefresh(refresh, 100)
  idle.retired()
  await vi.advanceTimersByTimeAsync(90)
  await expect(
    idle.request(() => {
      throw new Error('sync')
    })
  ).rejects.toThrow('sync')
  await vi.advanceTimersByTimeAsync(99)
  expect(refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('cancels the timer and prevents late request settlement from scheduling after teardown', async () => {
  vi.useFakeTimers()
  const refresh = vi.fn()
  const idle = createMonacoTsProgramIdleRefresh(refresh, 100)
  idle.retired()
  idle.dispose()
  expect(vi.getTimerCount()).toBe(0)
  await idle.request(async () => 1)
  idle.retired()
  idle.activity()
  await vi.advanceTimersByTimeAsync(1000)
  expect(refresh).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
