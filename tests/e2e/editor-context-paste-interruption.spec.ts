import { readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type * as Monaco from 'monaco-editor'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('large context-menu paste stops after a caret movement', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'paste-interruption.ts'
  const filePath = path.join(context.rootPath, relativePath)
  const first = 'PRIMARY_SELECTION'
  const second = 'SECONDARY_SELECTION'
  const middle = '// Between the two selections'
  const initial = `${first}\n${middle}\n${second}\n`
  await writeFile(filePath, initial)
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
  await orcaPage.evaluate(
    ({ context, relativePath, filePath }) =>
      window.__store?.getState().openFile(
        {
          worktreeId: context.worktreeId,
          filePath,
          relativePath,
          language: 'typescript',
          mode: 'edit'
        },
        { preview: false }
      ),
    { context, relativePath, filePath }
  )
  await expect(orcaPage.locator('.view-line').filter({ hasText: second })).toBeVisible({
    timeout: 60_000
  })
  const assets = await readdir(path.join(process.cwd(), 'out/renderer/assets'))
  const monacoAsset = assets.find(
    (name) => name.startsWith('monaco-setup-') && name.endsWith('.js')
  )
  if (!monacoAsset) {
    throw new Error('Expected bundled Monaco setup module')
  }
  const editor = await orcaPage.evaluateHandle(async (asset) => {
    const exports = await import(new URL(`./assets/${asset}`, document.baseURI).href)
    function isMonacoApi(value: unknown): value is typeof Monaco {
      return (
        typeof value === 'object' &&
        value !== null &&
        'editor' in value &&
        typeof value.editor === 'object' &&
        value.editor !== null &&
        'getEditors' in value.editor &&
        typeof value.editor.getEditors === 'function'
      )
    }
    const monaco = Object.values(exports).find(isMonacoApi)
    const editor = monaco?.editor
      .getEditors()
      .find(
        (candidate) =>
          candidate.getContainerDomNode().isConnected &&
          candidate.getModel()?.getValue().includes('SECONDARY_SELECTION')
      )
    if (!editor) {
      throw new Error('Expected the mounted multicursor source editor')
    }
    return editor
  }, monacoAsset)
  const large = '// PASTE_CHUNK_LINE\n'.repeat(6000)
  await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), large)
  await editor.evaluate((editor) => {
    editor.focus()
    editor.setPosition({ lineNumber: 1, column: 1 })
    const listener = editor.onDidChangeModelContent(() => {
      listener.dispose()
      queueMicrotask(() => editor.trigger('keyboard', 'cursorBottom', {}))
    })
  })
  await orcaPage.keyboard.press('Shift+F10')
  await expect(orcaPage.getByRole('menuitem', { name: /^Paste/ })).toBeVisible()
  // Monaco enables menu mouse-up 100 ms after opening.
  await orcaPage.getByRole('menuitem', { name: /^Paste/ }).click({ delay: 150 })
  await expect
    .poll(() => editor.evaluate((editor) => editor.getModel()?.getValueLength()))
    .toBeGreaterThan(initial.length)
  await orcaPage.waitForFunction(() => !document.querySelector('.monaco-menu-container'))
  const after = await editor.evaluate((editor) => ({
    value: editor.getModel()?.getValue(),
    selection: editor.getSelection()
  }))
  await orcaPage.screenshot({ path: testInfo.outputPath('caret-movement-during-paste.png') })
  const evidencePath = testInfo.outputPath('paste-interruption.json')
  await writeFile(
    evidencePath,
    JSON.stringify({ initial, payloadLength: large.length, after }, null, 2)
  )
  await testInfo.attach('paste-interruption', {
    path: evidencePath,
    contentType: 'application/json'
  })
  expect(after.value).toBe(large.slice(0, 16 * 1024) + initial)
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(() => editor.evaluate((editor) => editor.getModel()?.getValue())).toBe(initial)
  await editor.dispose()
})
