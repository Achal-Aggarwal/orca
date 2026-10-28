// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { captureWorktreeOperationGenerationSnapshot } from '@/lib/worktree-operation-generation'
import type { WorktreeOperationRoute } from '@/lib/worktree-operation-route'
import { buildFileViewPreferenceKey } from './file-view-preference-storage'
import { readPdfScalePreference, writePdfScalePreference } from './pdf-scale-preference-storage'

const initialState = useAppStore.getInitialState()
const folderId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const worktreeId = `folder:${folderId}`
const firstFolder = makeFolderWorkspace({
  id: folderId,
  folderPath: '/repo',
  executionHostId: 'ssh:first-host',
  connectionId: 'first-host'
})
const secondFolder = {
  ...firstFolder,
  executionHostId: 'ssh:second-host' as const,
  connectionId: 'second-host'
}

function openSource(hostId: 'ssh:first-host' | 'ssh:second-host') {
  useAppStore.getState().setActiveFolderWorkspace(folderId, hostId)
  const id = useAppStore.getState().openFile(
    {
      worktreeId,
      filePath: '/repo/report.pdf',
      relativePath: 'report.pdf',
      language: 'plaintext',
      mode: 'edit',
      runtimeEnvironmentId: null
    },
    { preview: false }
  )
  const file = useAppStore.getState().openFiles.find((file) => file.id === id)
  if (!file) throw new Error('Missing opened file')
  return file
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  localStorage.clear()
  useAppStore.setState({ folderWorkspaces: [firstFolder, secondFolder] })
})
afterEach(() => {
  useAppStore.setState(initialState, true)
  localStorage.clear()
})

describe('file view preferences across direct SSH owners', () => {
  it.each<{
    name: string
    route: WorktreeOperationRoute
    runtimeEnvironmentId?: string
    externalSshTargetId?: string
  }>([
    { name: 'local', route: { executionHostId: 'local', runtimeEnvironmentId: null } },
    {
      name: 'paired runtime',
      route: { executionHostId: 'runtime:paired-host', runtimeEnvironmentId: 'paired-host' },
      runtimeEnvironmentId: 'paired-host'
    },
    {
      name: 'external SSH',
      route: { executionHostId: 'ssh:host%3Aencoded', runtimeEnvironmentId: null },
      externalSshTargetId: 'host:encoded'
    }
  ])('preserves saved $name preferences when captured ownership is available', (owner) => {
    const file = {
      worktreeId,
      filePath: '/repo/report.pdf',
      runtimeEnvironmentId: owner.runtimeEnvironmentId,
      externalSshTargetId: owner.externalSshTargetId
    }
    const key = buildFileViewPreferenceKey(file)
    writePdfScalePreference(key, 1.25)
    const capturedKey = buildFileViewPreferenceKey({
      ...file,
      operationProvenance: {
        ownershipProjection: 'explicit',
        generation: captureWorktreeOperationGenerationSnapshot(owner.route)
      }
    })
    expect(capturedKey).toBe(key)
    expect(readPdfScalePreference(capturedKey)).toBe(1.25)
  })

  it('does not restore the prior host scale after closing and opening the same folder/path on another host', () => {
    const first = openSource('ssh:first-host')
    expect(first.operationProvenance?.generation.route.executionHostId).toBe('ssh:first-host')
    const firstKey = buildFileViewPreferenceKey(first)
    writePdfScalePreference(firstKey, 1.75)
    useAppStore.getState().closeFile(first.id)
    const second = openSource('ssh:second-host')
    expect(second.operationProvenance?.generation.route.executionHostId).toBe('ssh:second-host')
    expect(second.id).toBe(first.id)
    expect(readPdfScalePreference(buildFileViewPreferenceKey(second))).toBeNull()
    expect(readPdfScalePreference(firstKey)).toBe(1.75)
  })
})
