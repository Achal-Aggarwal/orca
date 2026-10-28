import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { buildOwnedEditorFileId } from '../../src/renderer/src/store/slices/editor/file-ids/editor-file-ids'

test('Rich Editor from a diff selects the reopened scoped source tab mode', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1400, height: 850 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = `diff-rich-${randomUUID()}.md`
  const filePath = path.join(context.rootPath, relativePath)
  await writeFile(filePath, '# Scoped source editor\n\nRich mode should open here.\n', 'utf8')
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
  const sourceId = buildOwnedEditorFileId(filePath, context.worktreeId, null)

  // Reopen preserves an existing scoped ID, as restored and recently closed tabs do.
  await orcaPage.evaluate(
    ({ filePath, relativePath, worktreeId, sourceId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Editor store unavailable')
      }
      const opened = store.getState().openFile(
        {
          filePath,
          relativePath,
          worktreeId,
          language: 'markdown',
          mode: 'edit',
          runtimeEnvironmentId: null
        },
        { reopenId: sourceId, preview: false }
      )
      if (opened !== sourceId) {
        throw new Error('Scoped source tab was not reopened')
      }
      store.getState().setMarkdownViewMode(opened, 'source')
    },
    { filePath, relativePath, worktreeId: context.worktreeId, sourceId }
  )
  await expect(orcaPage.getByRole('radio', { name: 'Source', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(orcaPage.locator('.monaco-editor')).toBeVisible()

  await orcaPage.evaluate(
    ({ filePath, relativePath, worktreeId }) => {
      window.__store?.getState().openDiff(worktreeId, filePath, relativePath, 'markdown', false, {
        runtimeEnvironmentId: null,
        preview: false
      })
    },
    { filePath, relativePath, worktreeId: context.worktreeId }
  )
  const rich = orcaPage.getByRole('radio', { name: 'Rich Editor', exact: true })
  await expect(rich).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('diff-before-rich-click.png') })
  await rich.click()
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeFileId))
    .toBe(sourceId)
  await expect(orcaPage.locator('.rich-markdown-editor, .monaco-editor').first()).toContainText(
    'Scoped source editor'
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('source-after-rich-click.png') })
  const mode = await orcaPage.evaluate((sourceId) => {
    const state = window.__store?.getState()
    return {
      sourceId,
      activeFileId: state?.activeFileId,
      markdownMode: state?.markdownViewMode[sourceId]
    }
  }, sourceId)
  await testInfo.attach('source-mode', {
    body: JSON.stringify(mode),
    contentType: 'application/json'
  })
  await expect(rich).toHaveAttribute('aria-checked', 'true')
  await expect(orcaPage.locator('.rich-markdown-editor')).toBeVisible()
  await expect(orcaPage.locator('.rich-markdown-editor h1')).toHaveText('Scoped source editor')
})
