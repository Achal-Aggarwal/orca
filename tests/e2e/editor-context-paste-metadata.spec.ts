import { readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type * as Monaco from 'monaco-editor'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('large in-app copy preserves distinct multicursor paste metadata', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  await orcaPage.evaluate(() =>
    window.__store?.getState().updateSettings({ editorWordWrap: false })
  )
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'paste-metadata.ts'
  const filePath = path.join(context.rootPath, relativePath)
  const alpha = `// ALPHA_COPY_BEGIN\n//${'a'.repeat(41000)}\n// ALPHA_COPY_END`
  const beta = `// BETA_COPY_BEGIN\n//${'b'.repeat(41000)}\n// BETA_COPY_END`
  const first = 'METADATA_TARGET_A'
  const second = 'METADATA_TARGET_B'
  const initial = `${alpha}\n${beta}\n// TARGET_REGION_BEGIN\n${first}\n${second}\n`
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
  await expect(orcaPage.locator('.view-line').filter({ hasText: 'ALPHA_COPY_BEGIN' })).toBeVisible({
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
          candidate.getModel()?.getValue().includes('ALPHA_COPY_BEGIN')
      )
    if (!editor) {
      throw new Error('Expected the mounted metadata source editor')
    }
    return editor
  }, monacoAsset)
  await editor.evaluate((editor) => editor.updateOptions({ wordWrap: 'off' }))
  const copyAndPaste = async (parts: string[], fromNativeCopy = true) => {
    if (fromNativeCopy) {
      await editor.evaluate(
        (editor, { alpha, parts }) => {
          const model = editor.getModel()
          if (!model) {
            throw new Error('Expected source model')
          }
          const starts = [0, alpha.length + 1]
          editor.focus()
          editor.setSelections(
            parts.map((part, index) => {
              const start = model.getPositionAt(starts[index])
              const end = model.getPositionAt(starts[index] + part.length)
              return {
                selectionStartLineNumber: start.lineNumber,
                selectionStartColumn: start.column,
                positionLineNumber: end.lineNumber,
                positionColumn: end.column
              }
            })
          )
        },
        { alpha, parts }
      )
      await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(parts.join('\n'))
    } else {
      await electronApp.evaluate(
        ({ clipboard }, text) => clipboard.writeText(text),
        parts.join('\n')
      )
    }
    await editor.evaluate(
      (editor, { first, second }) => {
        const model = editor.getModel()
        if (!model) {
          throw new Error('Expected target model')
        }
        editor.setSelections(
          [first, second].map((text) => {
            const range = model.findMatches(text, false, false, false, null, true)[0]?.range
            if (!range) {
              throw new Error('Expected target marker')
            }
            return {
              selectionStartLineNumber: range.startLineNumber,
              selectionStartColumn: range.startColumn,
              positionLineNumber: range.endLineNumber,
              positionColumn: range.endColumn
            }
          })
        )
        editor.revealLineInCenter(8)
      },
      { first, second }
    )
    await orcaPage.keyboard.press('Shift+F10')
    await expect(orcaPage.getByRole('menuitem', { name: /^Paste/ })).toBeVisible()
    await orcaPage.getByRole('menuitem', { name: /^Paste/ }).click()
  }
  const small = ['// ALPHA_COPY_BEGIN\n//a', '// BETA_COPY_BEGIN\n//b']
  await copyAndPaste(small)
  const smallExpected = initial.replace(first, small[0]).replace(second, small[1])
  await expect
    .poll(() => editor.evaluate((editor) => editor.getModel()?.getValue()))
    .toBe(smallExpected)
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(() => editor.evaluate((editor) => editor.getModel()?.getValue())).toBe(initial)
  await copyAndPaste([alpha, beta])
  await expect
    .poll(() =>
      editor.evaluate((editor) =>
        editor.getModel()?.getValue().split('// TARGET_REGION_BEGIN')[1]?.includes('BETA_COPY_END')
      )
    )
    .toBe(true)
  const after = await editor.evaluate((editor) => {
    const model = editor.getModel()
    const begin = model?.findMatches('// TARGET_REGION_BEGIN', false, false, false, null, true)[0]
      ?.range.startLineNumber
    if (begin) {
      editor.revealLineInCenter(begin)
    }
    editor.setScrollLeft(0)
    return { value: model?.getValue(), selectionCount: editor.getSelections()?.length }
  })
  await orcaPage.screenshot({ path: testInfo.outputPath('multicursor-copy-metadata.png') })
  const evidencePath = testInfo.outputPath('multicursor-copy-metadata.json')
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        byteLength: Buffer.byteLength(`${alpha}\n${beta}`),
        selectionCount: after.selectionCount,
        targetLabels: after.value
          ?.split('// TARGET_REGION_BEGIN')[1]
          ?.split('\n')
          .filter((line) => line.includes('COPY_'))
      },
      null,
      2
    )
  )
  await testInfo.attach('multicursor-copy-metadata', {
    path: evidencePath,
    contentType: 'application/json'
  })
  expect.soft(after.value === initial.replace(first, alpha).replace(second, beta)).toBe(true)
  expect(after.selectionCount).toBe(2)
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(() => editor.evaluate((editor) => editor.getModel()?.getValue())).toBe(initial)

  const externalSmall = ['EXTERNAL_ALPHA', 'EXTERNAL_BETA']
  await copyAndPaste(externalSmall, false)
  await expect
    .poll(() => editor.evaluate((editor) => editor.getModel()?.getValue()))
    .toBe(initial.replace(first, externalSmall[0]).replace(second, externalSmall[1]))
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(() => editor.evaluate((editor) => editor.getModel()?.getValue())).toBe(initial)
  const externalLarge = [
    `// EXTERNAL_ALPHA_${'a'.repeat(35000)}_END_A`,
    `// EXTERNAL_BETA_${'b'.repeat(35000)}_END_B`
  ]
  await copyAndPaste(externalLarge, false)
  await expect
    .poll(() =>
      editor.evaluate((editor) =>
        editor.getModel()?.getValue().split('// TARGET_REGION_BEGIN')[1]?.includes('_END_B')
      )
    )
    .toBe(true)
  const externalAfter = await editor.evaluate((editor) => {
    editor.revealLineInCenter(8)
    editor.setScrollLeft(0)
    return editor.getModel()?.getValue()
  })
  await orcaPage.screenshot({ path: testInfo.outputPath('external-line-spread.png') })
  expect
    .soft(
      externalAfter === initial.replace(first, externalLarge[0]).replace(second, externalLarge[1])
    )
    .toBe(true)
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(() => editor.evaluate((editor) => editor.getModel()?.getValue())).toBe(initial)

  const wholeLine = `// LARGE_WHOLE_LINE_COPY${'x'.repeat(68000)}`
  const smallLine = '// SMALL_WHOLE_LINE_COPY'
  const targetLine = '// WHOLE_LINE_TARGET'
  const wholeInitial = `${wholeLine}\n${smallLine}\n${targetLine}\n`
  await editor.evaluate((editor, value) => {
    editor.getModel()?.setValue(value)
    editor.focus()
  }, wholeInitial)
  const copyWholeLineAndPaste = async (lineNumber: number, copied: string) => {
    await editor.evaluate(
      (editor, lineNumber) => editor.setPosition({ lineNumber, column: 5 }),
      lineNumber
    )
    await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(`${copied}\n`)
    await editor.evaluate((editor) => editor.setPosition({ lineNumber: 3, column: 9 }))
    await orcaPage.keyboard.press('Shift+F10')
    await expect(orcaPage.getByRole('menuitem', { name: /^Paste/ })).toBeVisible()
    await orcaPage.getByRole('menuitem', { name: /^Paste/ }).click()
    await expect
      .poll(() => editor.evaluate((editor) => editor.getModel()?.getValueLength()))
      .toBe(wholeInitial.length + copied.length + 1)
  }
  await copyWholeLineAndPaste(2, smallLine)
  expect(await editor.evaluate((editor) => editor.getModel()?.getValue())).toBe(
    wholeInitial.replace(targetLine, `${smallLine}\n${targetLine}`)
  )
  expect(await editor.evaluate((editor) => editor.getPosition())).toEqual({
    lineNumber: 4,
    column: 9
  })
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect
    .poll(() => editor.evaluate((editor) => editor.getModel()?.getValue()))
    .toBe(wholeInitial)
  await copyWholeLineAndPaste(1, wholeLine)
  const wholeAfter = await editor.evaluate((editor) => {
    editor.revealLineInCenter(4)
    editor.setScrollLeft(0)
    return { value: editor.getModel()?.getValue(), position: editor.getPosition() }
  })
  await orcaPage.screenshot({ path: testInfo.outputPath('whole-line-copy-metadata.png') })
  expect
    .soft(wholeAfter.value === wholeInitial.replace(targetLine, `${wholeLine}\n${targetLine}`))
    .toBe(true)
  expect.soft(wholeAfter.position).toEqual({ lineNumber: 4, column: 9 })
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect
    .poll(() => editor.evaluate((editor) => editor.getModel()?.getValue()))
    .toBe(wholeInitial)

  await editor.dispose()
})
