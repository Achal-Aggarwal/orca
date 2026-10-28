import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { FolderWorkspace } from '../../src/shared/folder-workspace-types'

test('refuses side preview after the retained SSH source owner disappears', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const id = randomUUID()
  const worktreeId = `folder:${id}`
  const filePath = path.join(context.rootPath, 'report.html')
  const folder: FolderWorkspace = {
    id,
    projectGroupId: 'preview-owner-fixture',
    name: 'Retained SSH source',
    folderPath: context.rootPath,
    connectionId: 'preview-source-host',
    executionHostId: 'ssh:preview-source-host',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('fs:readFile')
    ipcMain.handle('fs:readFile', () => ({
      content: '<h1>Retained SSH report</h1>\n',
      isBinary: false
    }))
    ipcMain.removeHandler('folderWorkspaces:list')
    ipcMain.handle('folderWorkspaces:list', () => [])
  })
  const fileId = await orcaPage.evaluate(
    ({ folder, worktreeId, filePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Missing fixture store')
      }
      store.setState((state) => ({
        folderWorkspaces: [
          ...state.folderWorkspaces,
          folder,
          {
            ...folder,
            connectionId: undefined,
            executionHostId: 'runtime:other-preview-host' as const
          }
        ]
      }))
      store.getState().setActiveFolderWorkspace(folder.id, 'ssh:preview-source-host')
      return store.getState().openFile(
        {
          worktreeId,
          filePath,
          relativePath: 'report.html',
          language: 'html',
          mode: 'edit',
          runtimeEnvironmentId: null
        },
        { preview: false }
      )
    },
    { folder, worktreeId, filePath }
  )
  await expect(orcaPage.locator('.monaco-editor')).toBeVisible({ timeout: 25000 })
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot()?.valueTail))
    .toContain('Retained SSH report')
  const sourceOwner = await orcaPage.evaluate(
    (fileId) =>
      window.__store?.getState().openFiles.find((file) => file.id === fileId)?.operationProvenance
        ?.generation.route.executionHostId,
    fileId
  )
  expect(sourceOwner).toBe('ssh:preview-source-host')
  await orcaPage.evaluate(async () =>
    window.__store
      ?.getState()
      .fetchFolderWorkspaces({ runtimeEnvironmentId: null, throwOnError: true })
  )
  const before = await orcaPage.evaluate(
    (worktreeId) =>
      window.__store?.getState().browserTabsByWorktree[worktreeId]?.map((tab) => tab.id) ?? [],
    worktreeId
  )
  await orcaPage.getByRole('button', { name: 'Open Preview to the Side', exact: true }).click()
  await expect
    .soft(
      orcaPage.getByText(
        "Couldn't verify which host owns this file. Reopen the file after the connection settles.",
        { exact: true }
      )
    )
    .toBeVisible()
  await orcaPage.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  const after = await orcaPage.evaluate(
    (worktreeId) =>
      window.__store?.getState().browserTabsByWorktree[worktreeId]?.map((tab) => tab.id) ?? [],
    worktreeId
  )
  await writeFile(
    testInfo.outputPath('preview-owner-observations.json'),
    JSON.stringify(
      {
        sourceOwner,
        before,
        after,
        transport: 'Simulated SSH read at the IPC boundary; no live SSH connection'
      },
      null,
      2
    )
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('after-preview-click.png') })
  expect.soft(after).toEqual(before)
})
