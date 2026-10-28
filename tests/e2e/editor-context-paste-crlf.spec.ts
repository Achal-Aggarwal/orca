import { readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type * as Monaco from 'monaco-editor'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('context-menu paste keeps CRLF together at the chunk boundary', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'paste-crlf.ts'
  const filePath = path.join(context.rootPath, relativePath)
  const initial = '// CRLF_PASTE_TARGET\n'
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
  await expect(orcaPage.locator('.view-line').filter({ hasText: 'CRLF_PASTE_TARGET' })).toBeVisible(
    {
      timeout: 60_000
    }
  )
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
          candidate.getModel()?.getValue().includes('CRLF_PASTE_TARGET')
      )
    if (!editor) {
      throw new Error('Expected the mounted CRLF source editor')
    }
    return editor
  }, monacoAsset)
  await editor.evaluate((editor) => {
    editor.focus()
    editor.setPosition({ lineNumber: 2, column: 1 })
  })
  const marker = '// CRLF_BOUNDARY'
  const lead = '// FILLER\n'.repeat(1500)
  const paddingLength = 16383 - lead.length - 1 - marker.length
  const prefix = `${lead}${'//'.padEnd(paddingLength, 'x')}\n${marker}`
  expect(Buffer.byteLength(prefix)).toBe(16383)
  const text = `${prefix}\r\n// AFTER_BOUNDARY\n${'// TRAILING_LINE\n'.repeat(4000)}// CRLF_PASTE_END`
  await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), text)
  await orcaPage.keyboard.press('Shift+F10')
  await expect(orcaPage.getByRole('menuitem', { name: /^Paste/ })).toBeVisible()
  // Monaco enables menu mouse-up 100 ms after opening.
  await orcaPage.getByRole('menuitem', { name: /^Paste/ }).click({ delay: 150 })
  await expect
    .poll(() =>
      editor.evaluate((editor) => editor.getModel()?.getValue().includes('CRLF_PASTE_END'))
    )
    .toBe(true)
  const after = await editor.evaluate((editor) => {
    const model = editor.getModel()
    const value = model?.getValue()
    const beforeLine = model?.findMatches('// CRLF_BOUNDARY', false, false, false, null, true)[0]
      ?.range.startLineNumber
    const afterLine = model?.findMatches('// AFTER_BOUNDARY', false, false, false, null, true)[0]
      ?.range.startLineNumber
    if (beforeLine) {
      editor.revealLineInCenter(beforeLine)
    }
    return { value, beforeLine, afterLine }
  })
  await orcaPage.screenshot({ path: testInfo.outputPath('crlf-chunk-boundary.png') })
  const evidencePath = testInfo.outputPath('crlf-paste.json')
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        byteLength: Buffer.byteLength(text),
        beforeLine: after.beforeLine,
        afterLine: after.afterLine,
        boundaryText: after.value?.slice(
          initial.length + prefix.length - marker.length,
          initial.length + prefix.length + 30
        )
      },
      null,
      2
    )
  )
  await testInfo.attach('crlf-paste', { path: evidencePath, contentType: 'application/json' })
  expect(after.afterLine).toBe((after.beforeLine ?? 0) + 1)
  expect(after.value).toBe(initial + text.replace(/\r\n/g, '\n'))
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(() => editor.evaluate((editor) => editor.getModel()?.getValue())).toBe(initial)
  await editor.dispose()
})
