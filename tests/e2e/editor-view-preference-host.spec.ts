import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { FolderWorkspace } from '../../src/shared/folder-workspace-types'

test('keeps PDF zoom independent when the same folder/path is reopened on another SSH host', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const id = randomUUID()
  const folder: FolderWorkspace = {
    id,
    projectGroupId: 'view-preference-fixture',
    name: 'Host-specific PDF',
    folderPath: context.rootPath,
    connectionId: 'first-host',
    executionHostId: 'ssh:first-host',
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
  const content = createPdfFindFixture({ title: 'Host-specific PDF zoom' }).toString('base64')
  await electronApp.evaluate(({ ipcMain }, content) => {
    ipcMain.removeHandler('fs:readFile')
    ipcMain.handle('fs:readFile', () => ({
      content,
      isBinary: true,
      isImage: true,
      mimeType: 'application/pdf'
    }))
  }, content)
  await orcaPage.evaluate((folder) => {
    window.__store?.setState((state) => ({
      folderWorkspaces: [
        ...state.folderWorkspaces,
        folder,
        { ...folder, executionHostId: 'ssh:second-host' as const, connectionId: 'second-host' }
      ]
    }))
  }, folder)
  const open = async (host: 'ssh:first-host' | 'ssh:second-host') => {
    const file = await orcaPage.evaluate(
      ({ id, host, filePath }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Missing fixture store')
        }
        store.getState().setActiveFolderWorkspace(id, host)
        const fileId = store.getState().openFile(
          {
            worktreeId: `folder:${id}`,
            filePath,
            relativePath: 'report.pdf',
            language: 'plaintext',
            mode: 'edit',
            runtimeEnvironmentId: null
          },
          { preview: false }
        )
        const file = store.getState().openFiles.find((file) => file.id === fileId)
        return { id: fileId, host: file?.operationProvenance?.generation.route.executionHostId }
      },
      { id, host, filePath: path.join(context.rootPath, 'report.pdf') }
    )
    expect(file.host).toBe(host)
    await expect(orcaPage.locator('.pdfViewer:visible .page')).toHaveCount(3)
    await expect(orcaPage.locator('.pdfViewer:visible')).toContainText('Host-specific PDF zoom')
    return file.id
  }
  const scale = () =>
    orcaPage
      .getByTitle('Zoom in', { exact: true })
      .locator('..')
      .locator('.tabular-nums')
      .innerText()
  const firstId = await open('ssh:first-host')
  const defaultScale = await scale()
  await orcaPage.getByTitle('Zoom in', { exact: true }).click()
  await expect.poll(scale).not.toBe(defaultScale)
  const firstScale = await scale()
  await orcaPage
    .getByRole('button', { name: 'report.pdf Close tab', exact: true })
    .getByRole('button', { name: 'Close tab', exact: true })
    .click()
  await expect(orcaPage.locator('.pdfViewer:visible')).toHaveCount(0)
  const secondId = await open('ssh:second-host')
  const secondScale = await scale()
  await writeFile(
    testInfo.outputPath('host-preferences.json'),
    JSON.stringify(
      {
        firstId,
        secondId,
        defaultScale,
        firstScale,
        secondScale,
        transport: 'PDF read simulated at IPC; no live SSH connection'
      },
      null,
      2
    )
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('second-host-first-open.png') })
  expect(secondId).toBe(firstId)
  expect(secondScale).toBe(defaultScale)
})
