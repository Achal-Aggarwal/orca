import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('retains cell undo after editing another notebook cell', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'cell-undo-lifetime.ipynb'
  const filePath = path.join(context.rootPath, relativePath)
  const first = 'print("FIRST_ORIGINAL")'
  const second = 'print("SECOND_ORIGINAL")'
  await writeFile(
    filePath,
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: 'python' } },
      cells: [first, second].map((source, index) => ({
        id: `cell-${index}`,
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [source]
      }))
    })
  )
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
  await orcaPage.evaluate(
    ({ context, relativePath, filePath }) =>
      window.__store?.getState().openFile(
        {
          worktreeId: context.worktreeId,
          relativePath,
          filePath,
          language: 'json',
          mode: 'edit'
        },
        { preview: false }
      ),
    { context, relativePath, filePath }
  )
  const surfaces = orcaPage.locator('.ipynb-code-surface')
  await expect(surfaces).toHaveCount(2, { timeout: 60_000 })
  await surfaces.first().getByRole('button').click()
  await orcaPage.keyboard.press('End')
  await orcaPage.keyboard.type('X')
  await expect(surfaces.first().locator('.view-lines')).toHaveText(`${first}X`)
  await surfaces.nth(1).getByRole('button').click()
  await expect(surfaces.nth(1).locator('.monaco-editor')).toBeVisible()
  await orcaPage.keyboard.press('End')
  await orcaPage.keyboard.type('Y')
  await expect(surfaces.nth(1).locator('.view-lines')).toHaveText(`${second}Y`)
  await surfaces.first().getByRole('button').click()
  await expect(surfaces.first().locator('.monaco-editor')).toBeVisible()
  await expect(surfaces.first().locator('.view-lines')).toHaveText(`${first}X`)
  await orcaPage.screenshot({ path: testInfo.outputPath('cell-before-undo.png') })
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await orcaPage.screenshot({ path: testInfo.outputPath('cell-after-undo.png') })
  await expect(surfaces.first().locator('.view-lines')).toHaveText(first)
  await expect(surfaces.nth(1)).toHaveText(`${second}Y`)
})
