import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stubRpcClient } from '../../../transport/rpc-client-test-stub'
import type { RpcClient } from '../../../transport/rpc-client'
import { useMobileNativeChatFileSearch } from './use-mobile-native-chat-file-search'

type Search = ReturnType<typeof useMobileNativeChatFileSearch>
let tree: ReactTestRenderer | null = null
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.useRealTimers()
})

it.each([40, 400])(
  'evicts old queries after an empty mention across %i searches',
  async (count) => {
    const requests: string[] = []
    let generation = 1
    const client = stubRpcClient({
      getGeneration: () => generation,
      sendRequest: async (
        _method,
        params
      ): Promise<Awaited<ReturnType<RpcClient['sendRequest']>>> => {
        if (
          params === null ||
          typeof params !== 'object' ||
          !('query' in params) ||
          typeof params.query !== 'string'
        ) {
          throw new Error('Unexpected search')
        }
        requests.push(params.query)
        return {
          id: 'search',
          ok: true,
          result: {
            files: [{ relativePath: `generation-${generation}/${params.query || 'empty'}.ts` }]
          },
          _meta: { runtimeId: 'search' }
        }
      }
    })
    const search: { current: Search | null } = { current: null }
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
    await query('')
    for (let index = 0; index < count; index += 1) {
      await query(`file-${index}`)
    }
    const afterFill = requests.length
    await query(`file-${count - 1}`)
    expect(requests).toHaveLength(afterFill)
    expect(search.current?.nativeChatFilePaths).toEqual([`generation-1/file-${count - 1}.ts`])
    await query('file-0')
    const reloadedOldest = requests.length - afterFill
    await query('')
    const reloadedEmpty = requests.filter((value) => value === '').length
    expect(search.current?.nativeChatFilePaths).toEqual(['generation-1/empty.ts'])
    generation = 2
    await query(`file-${count - 1}`)
    expect(search.current?.nativeChatFilePaths).toEqual([`generation-2/file-${count - 1}.ts`])
    expect({ reloadedOldest, reloadedEmpty }).toEqual({ reloadedOldest: 1, reloadedEmpty: 2 })
  }
)
