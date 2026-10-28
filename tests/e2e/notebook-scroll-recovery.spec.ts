import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('remembers notebook scroll after an external edit repairs invalid source', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'scroll-recovery.ipynb'
  const filePath = path.join(context.rootPath, relativePath)
  const controlName = 'scroll-recovery-control.txt'
  const controlPath = path.join(context.rootPath, controlName)
  await writeFile(filePath, '{')
  await writeFile(controlPath, 'ORDINARY_FILE_CONTROL')
  registerPostElectronShutdownCleanup(async () => {
    await rm(filePath, { force: true })
    await rm(controlPath, { force: true })
  })
  await orcaPage.evaluate(
    async ({ context, relativePath, filePath, controlName, controlPath }) => {
      const state = window.__store?.getState()
      await state?.openFile(
        {
          worktreeId: context.worktreeId,
          relativePath: controlName,
          filePath: controlPath,
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
    { context, relativePath, filePath, controlName, controlPath }
  )
  await expect(orcaPage.getByText('Unable to render notebook', { exact: true })).toBeVisible({
    timeout: 60_000
  })
  await writeFile(
    filePath,
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: 'python' } },
      cells: Array.from({ length: 100 }, (_, index) => ({
        id: `cell-${index}`,
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [`print("RECOVERED_CELL_${index}")`]
      }))
    })
  )
  const surfaces = orcaPage.locator('.ipynb-code-surface')
  await expect(surfaces).toHaveCount(100, { timeout: 30_000 })
  const notebook = orcaPage.locator('.scrollbar-editor').filter({ has: surfaces.first() }).last()
  const box = await notebook.boundingBox()
  if (!box) {
    throw new Error('Recovered notebook viewport is unavailable')
  }
  await orcaPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await orcaPage.mouse.wheel(0, 500)
  await expect.poll(() => notebook.evaluate((node) => node.scrollTop)).toBe(500)
  await orcaPage.waitForTimeout(250)
  await orcaPage.locator('[data-tab-id]').filter({ hasText: controlName }).last().click()
  await expect(surfaces).toHaveCount(0)
  await orcaPage.locator('[data-tab-id]').filter({ hasText: relativePath }).last().click()
  await expect(surfaces).toHaveCount(100)
  await orcaPage.screenshot({ path: testInfo.outputPath('notebook-recovered-scroll.png') })
  await expect.poll(() => notebook.evaluate((node) => node.scrollTop)).toBe(500)
})
