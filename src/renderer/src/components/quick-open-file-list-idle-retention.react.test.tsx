// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useNativeChatMentionFiles } from './native-chat/use-native-chat-mention-files'
import { useFileExplorerNameFilter } from './right-sidebar/use-file-explorer-name-filter'
import {
  flushEffects,
  listRuntimeFilesMock,
  searchRuntimeFilePathsMock,
  makeFolderWorkspace,
  makeProjectGroup
} from './quick-open-file-list-test-harness'

vi.mock('@/runtime/runtime-file-search-client', async () => {
  const mocks = await import('./__mocks__/quick-open-runtime-file-client')
  return {
    listRuntimeFiles: mocks.listRuntimeFilesMock,
    cancelRuntimeFileList: mocks.cancelRuntimeFileListMock,
    searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock
  }
})

const workspaceId = folderWorkspaceKey('folder-workspace-1')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 8; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

beforeEach(() => {
  useAppStore.setState({
    activeWorktreeId: workspaceId,
    activeWorkspaceExecutionHostId: 'local',
    folderWorkspaces: [makeFolderWorkspace()],
    projectGroups: [makeProjectGroup()],
    repos: [],
    worktreesByRepo: {}
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe.each(['mention', 'explorer'] as const)('%s inventory ownership', (consumer) => {
  it('releases the closed consumer inventory and loads fresh paths on reopening', async () => {
    let retained: WeakRef<string[]> | undefined
    let loads = 0
    listRuntimeFilesMock.mockImplementation(async () => {
      loads++
      const paths = Array.from({ length: 20_000 }, (_, index) => `src/file-${loads}-${index}.ts`)
      retained = new WeakRef(paths)
      return paths
    })

    function useConsumer(enabled: boolean) {
      const mentions = useNativeChatMentionFiles({
        query: consumer === 'mention' && enabled ? 'file' : null,
        terminalTabId: 'chat',
        structuredWorktreeId: workspaceId
      })
      const explorer = useFileExplorerNameFilter({
        isFilesViewActive: consumer === 'explorer' && enabled,
        activeWorktreeId: workspaceId
      })
      return { mentions, explorer }
    }

    const hook = renderHook(({ enabled }) => useConsumer(enabled), {
      initialProps: { enabled: true }
    })
    if (consumer === 'explorer') {
      act(() => hook.result.current.explorer.setNameFilterQuery('file'))
    }
    await flushEffects()
    expect(loads).toBe(1)
    listRuntimeFilesMock.mockClear()
    await collect()
    expect(retained?.deref() !== undefined).toBe(true)

    for (let round = 0; round < 3; round++) {
      hook.rerender({ enabled: false })
      await flushEffects()
    }
    await collect()
    expect(retained?.deref() === undefined).toBe(true)
    expect(hook.result.current.mentions.files).toEqual([])
    expect(hook.result.current.explorer.nameFilterFiles.files).toEqual([])

    hook.rerender({ enabled: true })
    await flushEffects()
    expect(loads).toBe(2)
    if (consumer === 'mention') {
      expect(hook.result.current.mentions.files[0]).toContain('file-2-')
    } else {
      expect(hook.result.current.explorer.nameFilterFiles.files[0]).toContain('file-2-')
    }

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    searchRuntimeFilePathsMock.mockResolvedValue({
      files: ['src/remote-file.ts'],
      truncated: false
    })
    act(() => {
      useAppStore.setState({
        activeWorkspaceExecutionHostId: 'ssh:ssh-next',
        folderWorkspaces: [
          makeFolderWorkspace({ connectionId: 'ssh-next', folderPath: '/srv/next' })
        ],
        projectGroups: [makeProjectGroup({ connectionId: 'ssh-next', parentPath: '/srv/next' })]
      })
    })
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(loads).toBe(2)
    expect(searchRuntimeFilePathsMock.mock.calls.at(-1)?.[0]).toMatchObject({
      worktreePath: '/srv/next',
      connectionId: 'ssh-next'
    })
    if (consumer === 'mention') {
      expect(hook.result.current.mentions.files).toEqual(['src/remote-file.ts'])
    } else {
      expect(hook.result.current.explorer.nameFilterFiles.files).toEqual(['src/remote-file.ts'])
    }
  })
})
