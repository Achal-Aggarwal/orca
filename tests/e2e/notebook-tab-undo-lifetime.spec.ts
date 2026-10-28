import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('retains notebook cell undo after returning from another file tab', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'tab-undo-lifetime.ipynb'
  const filePath = path.join(context.rootPath, relativePath)
  const otherRelativePath = 'tab-undo-control.txt'
  const otherFilePath = path.join(context.rootPath, otherRelativePath)
  const first = 'print("NOTEBOOK_ORIGINAL")'
  await writeFile(
    filePath,
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: 'python' } },
      cells: [
        {
          id: 'cell-a',
          cell_type: 'code',
          metadata: {},
          execution_count: null,
          outputs: [],
          source: [first]
        }
      ]
    })
  )
  await writeFile(otherFilePath, 'ORDINARY_FILE_CONTROL')
  registerPostElectronShutdownCleanup(async () => {
    await rm(filePath, { force: true })
    await rm(otherFilePath, { force: true })
  })
  await orcaPage.evaluate(
    async ({ context, relativePath, filePath, otherRelativePath, otherFilePath }) => {
      const state = window.__store?.getState()
      await state?.openFile(
        {
          worktreeId: context.worktreeId,
          relativePath: otherRelativePath,
          filePath: otherFilePath,
          language: 'plaintext',
          mode: 'edit'
        },
        { preview: false }
      )
      await state?.openFile(
        {
          worktreeId: context.worktreeId,
          relativePath,
          filePath,
          language: 'json',
          mode: 'edit'
        },
        { preview: false }
      )
    },
    { context, relativePath, filePath, otherRelativePath, otherFilePath }
  )
  const surface = orcaPage.locator('.ipynb-code-surface')
  await expect(surface).toHaveCount(1, { timeout: 60_000 })
  await surface.getByRole('button').click()
  await orcaPage.keyboard.press('End')
  await orcaPage.keyboard.type('X')
  await expect(surface.locator('.view-lines')).toHaveText(`${first}X`)
  await orcaPage.locator('[data-tab-id]').filter({ hasText: otherRelativePath }).last().click()
  await expect(surface).toHaveCount(0)
  await expect(orcaPage.locator('.monaco-editor .view-lines').first()).toHaveText(
    'ORDINARY_FILE_CONTROL'
  )
  await orcaPage.locator('[data-tab-id]').filter({ hasText: relativePath }).last().click()
  await expect(surface).toHaveCount(1)
  await surface.getByRole('button').click()
  await expect(surface.locator('.view-lines')).toHaveText(`${first}X`)
  await orcaPage.screenshot({ path: testInfo.outputPath('notebook-before-undo.png') })
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await orcaPage.screenshot({ path: testInfo.outputPath('notebook-after-undo.png') })
  await expect(surface.locator('.view-lines')).toHaveText(first)
})
