import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

test('shows an empty original for a new file containing brackets', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'literal-added-file')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const fileName = 'new [draft].ts'
  const addedLine = 'export const draft = "new file"'
  writeFileSync(path.join(fixture.worktreePath, fileName), `${addedLine}\n`)

  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
  const row = orcaPage
    .locator('[data-testid="source-control-entry"][data-source-control-area="untracked"]')
    .filter({ hasText: fileName })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await expect(orcaPage.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20_000 })
  await expect(
    orcaPage.locator('.modified-in-monaco-diff-editor .view-line').filter({ hasText: addedLine })
  ).toBeVisible()
  await orcaPage.screenshot({
    path: process.env.ORCA_GIT_BLOB_PROOF_PATH ?? testInfo.outputPath('literal-added-file.png')
  })
  const original = await orcaPage
    .locator('.original-in-monaco-diff-editor .view-line')
    .allTextContents()
  expect(original.join('\n').trim()).toBe('')
})
