import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stubRpcClient } from '../../../transport/rpc-client-test-stub'
import type { RpcClient } from '../../../transport/rpc-client'
import { useMobileNativeChatFileSearch } from './use-mobile-native-chat-file-search'
import * as ranking from '../../../../../src/shared/quick-open-path-search'

type Reply = Awaited<ReturnType<RpcClient['sendRequest']>>
let tree: ReactTestRenderer | null = null
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([10, 100])(
  'ranks one live query after %i queries join a slow legacy inventory',
  async (count) => {
    let release = (_reply: Reply): void => {}
    const pending = new Promise<Reply>((resolve) => {
      release = resolve
    })
    let lists = 0
    const client = stubRpcClient({
      sendRequest: async (method): Promise<Reply> => {
        if (method === 'files.searchPaths') {
          return {
            id: 'missing',
            ok: false,
            error: { code: 'method_not_found', message: 'Legacy host' },
            _meta: { runtimeId: 'legacy' }
          }
        }
        lists += 1
        return pending
      }
    })
    const rank = vi.spyOn(ranking, 'rankQuickOpenFiles')
    const search: { current: ReturnType<typeof useMobileNativeChatFileSearch> | null } = {
      current: null
    }
    function Probe() {
      search.current = useMobileNativeChatFileSearch({ client, worktreeId: 'folder:remote' })
      return null
    }
    await act(async () => {
      tree = create(createElement(Probe))
    })
    async function query(value: string) {
      act(() => search.current?.loadNativeChatFiles(value))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120)
      })
    }
    for (let index = 0; index < count; index += 1) {
      await query(index === count - 1 ? 'needle' : `absent-${index}`)
    }
    expect(lists).toBe(1)
    const files = Array.from({ length: 1000 }, (_, index) => ({
      relativePath: `src/file-${index}.ts`
    }))
    files.push({ relativePath: 'src/needle.ts' })
    await act(async () => {
      release({ id: 'files', ok: true, result: { files }, _meta: { runtimeId: 'legacy' } })
      await pending
    })
    expect(search.current?.nativeChatFilePaths).toEqual(['src/needle.ts'])
    const ranksAfterRelease = rank.mock.calls.length
    const inspectedPaths = rank.mock.calls.reduce((sum, [, paths]) => sum + paths.length, 0)
    await query('file-999')
    expect(search.current?.nativeChatFilePaths).toContain('src/file-999.ts')
    expect(lists).toBe(1)
    const afterNext = rank.mock.calls.length
    await query('needle')
    expect(rank).toHaveBeenCalledTimes(afterNext)
    expect(search.current?.nativeChatFilePaths).toEqual(['src/needle.ts'])
    expect({ ranksAfterRelease, inspectedPaths }).toEqual({
      ranksAfterRelease: 1,
      inspectedPaths: 1001
    })
  }
)
