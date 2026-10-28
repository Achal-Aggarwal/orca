import { readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type * as Monaco from 'monaco-editor'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('large context-menu paste keeps both selections and one undo step', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'paste-multicursor.ts'
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
  const setSelections = () =>
    editor.evaluate(
      (editor, { first, second }) => {
        editor.focus()
        editor.setSelections([
          {
            selectionStartLineNumber: 1,
            selectionStartColumn: 1,
            positionLineNumber: 1,
            positionColumn: first.length + 1
          },
          {
            selectionStartLineNumber: 3,
            selectionStartColumn: 1,
            positionLineNumber: 3,
            positionColumn: second.length + 1
          }
        ])
      },
      { first, second }
    )
  const pasteFromMenu = async (text: string) => {
    await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), text)
    await setSelections()
    expect(await editor.evaluate((editor) => editor.getSelections()?.length)).toBe(2)
    await orcaPage.keyboard.press('Shift+F10')
    await expect(orcaPage.getByRole('menuitem', { name: /^Paste/ })).toBeVisible()
    expect(await editor.evaluate((editor) => editor.getSelections()?.length)).toBe(2)
    // Monaco enables menu mouse-up 100 ms after opening.
    await orcaPage.getByRole('menuitem', { name: /^Paste/ }).click({ delay: 150 })
  }
  await pasteFromMenu('SMALL_PASTE')
  await expect
    .poll(() => editor.evaluate((editor) => editor.getModel()?.getValue()))
    .toBe(`SMALL_PASTE\n${middle}\nSMALL_PASTE\n`)
  expect(await editor.evaluate((editor) => editor.getSelections()?.length)).toBe(2)
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(() => editor.evaluate((editor) => editor.getModel()?.getValue())).toBe(initial)

  const large = `${'// PASTED_MULTI_CURSOR_LINE\n'.repeat(3000)}// END_MULTI_CURSOR_PASTE`
  await setSelections()
  await orcaPage.screenshot({ path: testInfo.outputPath('before-large-multicursor-paste.png') })
  await pasteFromMenu(large)
  await expect
    .poll(() =>
      editor.evaluate((editor) =>
        editor.getModel()?.getValue().includes('// END_MULTI_CURSOR_PASTE')
      )
    )
    .toBe(true)
  const after = await editor.evaluate((editor) => ({
    value: editor.getModel()?.getValue(),
    selections: editor.getSelections()?.map((selection) => ({
      line: selection.positionLineNumber,
      column: selection.positionColumn
    }))
  }))
  await editor.evaluate((editor) => {
    const first = editor.getSelections()?.[0]
    if (first) {
      editor.revealLineInCenter(first.positionLineNumber)
    }
  })
  await orcaPage.screenshot({ path: testInfo.outputPath('after-large-multicursor-paste.png') })
  const evidencePath = testInfo.outputPath('large-multicursor-paste.json')
  await writeFile(
    evidencePath,
    JSON.stringify({ byteLength: Buffer.byteLength(large), after }, null, 2)
  )
  await testInfo.attach('large-multicursor-paste', {
    path: evidencePath,
    contentType: 'application/json'
  })
  expect(after.value).toBe(`${large}\n${middle}\n${large}\n`)
  expect(after.selections).toHaveLength(2)
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(() => editor.evaluate((editor) => editor.getModel()?.getValue())).toBe(initial)
  await editor.dispose()
})
