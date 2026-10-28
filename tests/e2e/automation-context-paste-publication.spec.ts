import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type * as Monaco from 'monaco-editor'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('automation menu paste publishes once at N and 10N and retains Undo', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const route = 'automation'
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  const initial = ''
  await orcaPage.evaluate(() => window.__store?.getState().openAutomationsPage())
  await expect(orcaPage.getByRole('heading', { name: 'Automations', exact: true })).toBeVisible()
  await orcaPage.getByRole('button', { name: /new automation/i }).click()
  const selector = '[data-slot="automation-prompt-editor"]'
  await expect(orcaPage.locator(`${selector} .monaco-editor`)).toBeVisible()
  const assets = await readdir(path.join(process.cwd(), 'out/renderer/assets'))
  const asset = assets.find((name) => name.startsWith('monaco-setup-') && name.endsWith('.js'))
  if (!asset) throw new Error('Missing Monaco setup asset')
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
      if (!instance || !model) throw new Error('Missing target editor/model')
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
        const stack = new Error().stack?.split('\n').slice(2, 5).join('\n') ?? ''
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
      return { instance, model, stats, original }
    },
    { asset, selector }
  )
  const measurements = []
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
      if (end) instance.setPosition({ lineNumber: end.endLineNumber, column: end.endColumn })
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
    expect(
      measurement.stacks
        .filter(([, entry]) => entry.units > 0)
        .reduce((total, [, entry]) => total + entry.reads, 0)
    ).toBe(1)
    expect(await probe.evaluate(({ original }) => original())).toBe(initial + text)
    await orcaPage.screenshot({ path: testInfo.outputPath(`${route}-${size}-paste.png`) })
    await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expect
      .poll(() => probe.evaluate(({ model }) => (model.isDisposed() ? -1 : model.getValueLength())))
      .toBe(initial.length)
  }
  await writeFile(
    testInfo.outputPath(`${route}-counts.json`),
    JSON.stringify(measurements, null, 2)
  )
  console.log(JSON.stringify({ route, measurements }))
})
