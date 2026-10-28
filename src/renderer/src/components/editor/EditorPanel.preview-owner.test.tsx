// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { getWorkspaceFilePreviewPlan } from '@/lib/file-preview'
import type * as FilePreview from '@/lib/file-preview'

const preview = vi.hoisted(() => vi.fn())
vi.mock('@/lib/file-preview', async (importActual) => ({
  ...(await importActual<typeof FilePreview>()),
  openFilePreviewToSide: preview
}))
vi.mock('./useEditorPanelContentState', () => ({
  useEditorPanelContentState: () => ({
    fileContents: {},
    diffContents: {},
    reloadContent: () => {}
  })
}))
vi.mock('./EditorPanelShell', () => ({
  EditorPanelShell: ({
    model,
    onOpenPreviewToSide
  }: {
    model: { canOpenPreviewToSide: boolean }
    onOpenPreviewToSide: () => void
  }) =>
    model.canOpenPreviewToSide ? (
      <button onClick={onOpenPreviewToSide}>Open preview to side</button>
    ) : null
}))
import EditorPanel from './EditorPanel'

const initialState = useAppStore.getInitialState()
let container: HTMLDivElement
let root: Root
const folderId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const worktreeId = `folder:${folderId}`
const sshFolder = makeFolderWorkspace({
  id: folderId,
  folderPath: '/repo',
  executionHostId: 'ssh:source-host',
  connectionId: 'source-host'
})
const otherFolder = {
  ...sshFolder,
  connectionId: undefined,
  executionHostId: 'runtime:other-host' as const
}

describe('editor preview source ownership', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState(initialState, true)
    preview.mockClear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'api')
    useAppStore.setState(initialState, true)
  })

  it('allows the current SSH source without requiring mutation-only connection metadata', async () => {
    useAppStore.setState({
      folderWorkspaces: [sshFolder],
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: 'ssh:source-host'
    })
    const fileId = useAppStore.getState().openFile(
      {
        worktreeId,
        filePath: '/repo/report.html',
        relativePath: 'report.html',
        language: 'html',
        mode: 'edit',
        runtimeEnvironmentId: null
      },
      { preview: false }
    )
    await act(async () => root.render(<EditorPanel activeFileId={fileId} />))
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    await act(async () => button?.click())
    expect(preview).toHaveBeenCalledTimes(1)
  })

  it('refuses a retained source after its folder owner disappears from a real catalog refresh', async () => {
    useAppStore.setState({
      folderWorkspaces: [sshFolder, otherFolder],
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: 'ssh:source-host'
    })
    const fileId = useAppStore.getState().openFile(
      {
        worktreeId,
        filePath: '/repo/report.html',
        relativePath: 'report.html',
        language: 'html',
        mode: 'edit',
        runtimeEnvironmentId: null
      },
      { preview: false }
    )
    const source = useAppStore.getState().openFiles.find((file) => file.id === fileId)
    expect(source?.operationProvenance?.generation.route.executionHostId).toBe('ssh:source-host')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { folderWorkspaces: { list: vi.fn().mockResolvedValue([]) } }
    })
    await useAppStore
      .getState()
      .fetchFolderWorkspaces({ runtimeEnvironmentId: null, throwOnError: true })
    expect(useAppStore.getState().folderWorkspaces).toEqual([otherFolder])
    expect(useAppStore.getState().openFiles.find((file) => file.id === fileId)).toBe(source)
    expect(
      getWorkspaceFilePreviewPlan(useAppStore.getState(), worktreeId, '/repo/report.html').status
    ).toBe('browser-tab')
    await act(async () => root.render(<EditorPanel activeFileId={fileId} />))
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    await act(async () => button?.click())
    expect(preview).not.toHaveBeenCalled()
  })
})
