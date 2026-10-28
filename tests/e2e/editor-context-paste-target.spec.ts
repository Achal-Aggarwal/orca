import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type * as Monaco from 'monaco-editor'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('context-menu paste keeps its original model while an unstaged diff refreshes', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'src/index.ts'
  const filePath = path.join(context.rootPath, relativePath)
  const initial = 'export const hello = "before clipboard read"\n'
  const refreshed = 'export const hello = "external replacement"\n'
  const clipboardText = 'LATE_CLIPBOARD_TEXT'
  await writeFile(filePath, initial)
  await orcaPage.evaluate(
    ({ context, relativePath, filePath }) => {
      window.__store
        ?.getState()
        .openDiff(context.worktreeId, filePath, relativePath, 'typescript', false, {
          preview: false
        })
    },
    { context, relativePath, filePath }
  )
  await expect(orcaPage.locator('.monaco-diff-editor')).toBeVisible()
  await expect(
    orcaPage
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: 'before clipboard read' })
  ).toBeVisible()

  const assets = await readdir(path.join(process.cwd(), 'out/renderer/assets'))
  const monacoAsset = assets.find(
    (name) => name.startsWith('monaco-setup-') && name.endsWith('.js')
  )
  if (!monacoAsset) {
    throw new Error('Expected bundled Monaco setup module')
  }
  const diff = await orcaPage.evaluateHandle(async (asset) => {
    const exports = await import(new URL(`./assets/${asset}`, document.baseURI).href)
    function isMonacoApi(value: unknown): value is typeof Monaco {
      return (
        typeof value === 'object' &&
        value !== null &&
        'editor' in value &&
        typeof value.editor === 'object' &&
        value.editor !== null &&
        'getDiffEditors' in value.editor &&
        typeof value.editor.getDiffEditors === 'function'
      )
    }
    const monaco = Object.values(exports).find(isMonacoApi)
    const editor = monaco?.editor
      .getDiffEditors()
      .find((candidate) =>
        candidate.getModel()?.modified.getValue().includes('before clipboard read')
      )
    if (!editor) {
      throw new Error('Expected the actual unstaged diff editor')
    }
    return editor
  }, monacoAsset)
  const originalModel = await diff.evaluateHandle((editor) => editor.getModel()?.modified)
  const readGate = await electronApp.evaluateHandle(({ ipcMain }, text) => {
    let releaseRead: ((text: string) => void) | undefined
    let started = false
    let released = false
    ipcMain.removeHandler('clipboard:readText')
    ipcMain.handle('clipboard:readText', () => {
      if (released) {
        return text
      }
      started = true
      return new Promise<string>((resolve) => {
        releaseRead = resolve
      })
    })
    return {
      started: () => started,
      release: () => {
        released = true
        releaseRead?.(text)
      }
    }
  }, clipboardText)
  const modified = orcaPage.locator('.modified-in-monaco-diff-editor')
  await modified
    .locator('.view-line')
    .filter({ hasText: 'before clipboard read' })
    .click({ button: 'right' })
  // Monaco enables menu mouse-up 100 ms after opening.
  await orcaPage.getByRole('menuitem', { name: /^Paste/ }).click({ delay: 150 })
  await expect.poll(() => readGate.evaluate((gate) => gate.started())).toBe(true)
  await orcaPage.screenshot({ path: testInfo.outputPath('clipboard-read-pending.png') })

  await writeFile(filePath, refreshed)
  await expect
    .poll(() => diff.evaluate((editor) => editor.getModel()?.modified.getValue()))
    .toBe(refreshed)
  const replacementModel = await diff.evaluateHandle((editor) => editor.getModel()?.modified)
  expect(
    await originalModel.evaluate(
      (original, replacement) => original === replacement,
      replacementModel
    )
  ).toBe(false)
  expect(await diff.evaluate((editor) => editor.getModifiedEditor().hasTextFocus())).toBe(true)
  await orcaPage.screenshot({ path: testInfo.outputPath('replacement-before-paste.png') })
  await readGate.evaluate((gate) => gate.release())
  await orcaPage.evaluate(async () => {
    await window.api.ui.readClipboardText()
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  })
  const value = await diff.evaluate((editor) => editor.getModel()?.modified.getValue())
  await orcaPage.screenshot({ path: testInfo.outputPath('replacement-after-paste.png') })
  const evidencePath = testInfo.outputPath('paste-target.json')
  await writeFile(
    evidencePath,
    JSON.stringify({ initial, refreshed, clipboardText, value }, null, 2)
  )
  await testInfo.attach('paste-target', { path: evidencePath, contentType: 'application/json' })
  expect(value).toBe(refreshed)
  await diff.dispose()
  await originalModel.dispose()
  await replacementModel.dispose()
  await readGate.dispose()
})
