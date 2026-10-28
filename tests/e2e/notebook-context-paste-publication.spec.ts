import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type * as Monaco from 'monaco-editor'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { parseIpynb } from '../../src/renderer/src/components/editor/ipynb-parse'

async function savedCellSource(filePath: string): Promise<string | undefined> {
  try {
    return parseIpynb(await readFile(filePath, 'utf8')).cells[0]?.source
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined
    }
    throw error
  }
}

test('notebook menu paste batches publication and drains Save and tab teardown', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  const route = 'notebook'
  const initial = 'print("PASTE_BASE")'
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'paste-audit.ipynb'
  const filePath = path.join(context.rootPath, relativePath)
  const otherRelativePath = 'paste-control.txt'
  const otherFilePath = path.join(context.rootPath, otherRelativePath)
  await writeFile(otherFilePath, 'OTHER_TAB_CONTROL')
  await writeFile(
    filePath,
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: 'python' } },
      cells: [
        {
          id: 'paste-a',
          cell_type: 'code',
          metadata: {},
          execution_count: null,
          outputs: [],
          source: [initial]
        }
      ]
    })
  )
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
          filePath: otherFilePath,
          relativePath: otherRelativePath,
          language: 'plaintext',
          mode: 'edit'
        },
        { preview: false }
      )
      await state?.openFile(
        {
          worktreeId: context.worktreeId,
          filePath,
          relativePath,
          language: 'json',
          mode: 'edit'
        },
        { preview: false }
      )
    },
    { context, relativePath, filePath, otherRelativePath, otherFilePath }
  )
  await expect(orcaPage.locator('.ipynb-code-surface')).toHaveCount(1)
  await orcaPage.locator('.ipynb-code-surface').getByRole('button').click()
  const selector = '.ipynb-code-surface'
  await expect(orcaPage.locator(`${selector} .monaco-editor`)).toBeVisible()
  const assets = await readdir(path.join(process.cwd(), 'out/renderer/assets'))
  const asset = assets.find((name) => name.startsWith('monaco-setup-') && name.endsWith('.js'))
  if (!asset) {
    throw new Error('Missing Monaco setup asset')
  }
  const probe = await orcaPage.evaluateHandle(
    async ({ asset, selector }) => {
      const exports = await import(new URL(`./assets/${asset}`, document.baseURI).href)
      function isMonaco(value: unknown): value is typeof Monaco {
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
      const api = Object.values(exports).find(isMonaco)
      const instance = api?.editor
        .getEditors()
        .find((candidate) => candidate.getContainerDomNode().closest(selector))
      const model = instance?.getModel()
      if (!instance || !model) {
        throw new Error('Missing target editor/model')
      }
      const stats = {
        reads: 0,
        units: 0,
        events: 0,
        blur: 0,
        disposed: 0,
        stacks: new Map<string, { reads: number; units: number }>()
      }
      const original = model.getValue.bind(model)
      model.getValue = (...args: Parameters<typeof original>) => {
        const value = original(...args)
        const stack =
          new Error('paste full-value read').stack?.split('\n').slice(2, 5).join('\n') ?? ''
        const entry = stats.stacks.get(stack) ?? { reads: 0, units: 0 }
        entry.reads += 1
        entry.units += value.length
        stats.stacks.set(stack, entry)
        stats.reads += 1
        stats.units += value.length
        return value
      }
      model.onDidChangeContent(() => (stats.events += 1))
      instance.onDidBlurEditorWidget(() => (stats.blur += 1))
      model.onWillDispose(() => (stats.disposed += 1))
      const control = { held: false, release: () => {} }
      const holdAfterThirdChunk = (): void => {
        stats.events = 0
        control.held = false
        const postMessage = MessagePort.prototype.postMessage
        MessagePort.prototype.postMessage = function (
          this: MessagePort,
          message: unknown,
          options?: StructuredSerializeOptions | Transferable[]
        ): void {
          const forward = postMessage.bind(this)
          const send = (): void => {
            if (Array.isArray(options)) {
              forward(message, options)
            } else {
              forward(message, options)
            }
          }
          if (stats.events === 3 && typeof message === 'number') {
            MessagePort.prototype.postMessage = postMessage
            control.held = true
            control.release = send
            return
          }
          send()
        }
      }
      return { instance, model, stats, original, control, holdAfterThirdChunk }
    },
    { asset, selector }
  )
  const measurements: { size: number; reads: number; units: number; events: number }[] = []
  for (const size of [81920, 819200]) {
    const text = 'PASTE_LINE\n'.repeat(Math.floor(size / 11))
    await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), text)
    await probe.evaluate(({ instance, stats }) => {
      stats.reads = 0
      stats.units = 0
      stats.events = 0
      stats.blur = 0
      stats.stacks.clear()
      instance.focus()
      const model = instance.getModel()
      const end = model?.getFullModelRange()
      if (end) {
        instance.setPosition({ lineNumber: end.endLineNumber, column: end.endColumn })
      }
    })
    await orcaPage.keyboard.press('Shift+F10')
    await expect(orcaPage.getByRole('menuitem', { name: /^Paste/ })).toBeVisible()
    // Monaco enables menu mouse-up 100 ms after opening.
    await orcaPage.getByRole('menuitem', { name: /^Paste/ }).click({ delay: 150 })
    await expect
      .poll(() => probe.evaluate(({ model }) => (model.isDisposed() ? -1 : model.getValueLength())))
      .toBe(initial.length + text.length)
    await expect(orcaPage.getByRole('menuitem', { name: /^Paste/ })).toHaveCount(0)
    const measurement = await probe.evaluate(({ model, stats }) => ({
      length: model.getValueLength(),
      ...stats,
      stacks: [...stats.stacks]
    }))
    measurements.push({ size: text.length, ...measurement })
    expect(measurement.reads).toBe(1)
    expect(await probe.evaluate(({ original }) => original())).toBe(initial + text)
    await orcaPage.screenshot({ path: testInfo.outputPath(`${route}-${size}-paste.png`) })
    await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expect
      .poll(() => probe.evaluate(({ model }) => (model.isDisposed() ? -1 : model.getValueLength())))
      .toBe(initial.length)
  }
  const primary = process.platform === 'darwin' ? 'Meta' : 'Control'
  const continued = 'PASTE_LINE\n'.repeat(Math.floor(819200 / 11))
  const partial = initial + continued.slice(0, 3 * 16384)
  const beginHeldPaste = async (): Promise<void> => {
    await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), continued)
    await probe.evaluate(({ instance, holdAfterThirdChunk }) => {
      instance.focus()
      holdAfterThirdChunk()
    })
    await orcaPage.keyboard.press('Shift+F10')
    await expect(orcaPage.getByRole('menuitem', { name: /^Paste/ })).toBeVisible()
    // Monaco enables menu mouse-up 100 ms after opening.
    await orcaPage.getByRole('menuitem', { name: /^Paste/ }).click({ delay: 150 })
    await expect.poll(() => probe.evaluate(({ control }) => control.held)).toBe(true)
    expect(await probe.evaluate(({ model }) => model.getValueLength())).toBe(partial.length)
  }
  await beginHeldPaste()
  await orcaPage.keyboard.press(`${primary}+s`)
  await expect.poll(() => savedCellSource(filePath)).toBe(partial)
  expect(await probe.evaluate(({ stats }) => stats.events)).toBe(3)
  await orcaPage.screenshot({ path: testInfo.outputPath('notebook-mid-paste-saved.png') })
  await probe.evaluate(({ control }) => control.release())
  await expect
    .poll(() => probe.evaluate(({ model }) => model.getValueLength()))
    .toBe(initial.length + continued.length)
  expect(await probe.evaluate(({ original }) => original())).toBe(initial + continued)
  await orcaPage.keyboard.press(`${primary}+z`)
  await expect
    .poll(() => probe.evaluate(({ model }) => model.getValueLength()))
    .toBe(initial.length)
  await orcaPage.keyboard.press(`${primary}+s`)
  await expect.poll(() => savedCellSource(filePath)).toBe(initial)

  await beginHeldPaste()
  await orcaPage.locator('[data-tab-id]').filter({ hasText: otherRelativePath }).click()
  await expect(orcaPage.locator('.ipynb-code-surface')).toHaveCount(0)
  await probe.evaluate(({ control }) => control.release())
  await expect.poll(() => probe.evaluate(({ model }) => model.isDisposed())).toBe(true)
  await orcaPage.locator('[data-tab-id]').filter({ hasText: relativePath }).click()
  await expect(orcaPage.locator('.ipynb-code-surface')).toHaveCount(1)
  await orcaPage.getByRole('button', { name: 'Save notebook', exact: true }).click()
  await expect.poll(() => savedCellSource(filePath)).toBe(partial)
  await orcaPage.screenshot({ path: testInfo.outputPath('notebook-paste-tab-return.png') })
  await writeFile(
    testInfo.outputPath(`${route}-counts.json`),
    JSON.stringify(measurements, null, 2)
  )
  console.log(JSON.stringify({ route, measurements }))
})
