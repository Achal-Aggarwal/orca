import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('keeps the current notebook scroll when a pending cell draft publishes', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'scroll-publication.ipynb'
  const filePath = path.join(context.rootPath, relativePath)
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
        source: [`print("SCROLL_CELL_${index}")`]
      }))
    })
  )
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
  await orcaPage.evaluate(
    ({ context, relativePath, filePath }) =>
      window.__store?.getState().openFile(
        {
          worktreeId: context.worktreeId,
          relativePath,
          filePath,
          language: 'json',
          mode: 'edit'
        },
        { preview: false }
      ),
    { context, relativePath, filePath }
  )
  const surfaces = orcaPage.locator('.ipynb-code-surface')
  await expect(surfaces).toHaveCount(100, { timeout: 60_000 })
  const notebook = orcaPage.locator('.scrollbar-editor').filter({ has: surfaces.first() }).last()
  const box = await notebook.boundingBox()
  if (!box) {
    throw new Error('Notebook viewport is unavailable')
  }
  await orcaPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await orcaPage.mouse.wheel(0, 300)
  await expect.poll(() => notebook.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  await orcaPage.mouse.wheel(0, -1000)
  await expect.poll(() => notebook.evaluate((node) => node.scrollTop)).toBe(0)
  await orcaPage.waitForTimeout(200)
  await surfaces.first().getByRole('button').click()
  const draftCommit = await orcaPage.evaluateHandle(() => {
    const commit: { release?: () => void } = {}
    const schedule = window.setTimeout
    window.setTimeout = new Proxy(schedule, {
      apply(target, _receiver: unknown, args: Parameters<typeof window.setTimeout>) {
        const [callback, delay, ...callbackArgs] = args
        if (delay === 400 && typeof callback === 'function') {
          window.setTimeout = schedule
          const timer = schedule(() => {}, 60_000)
          commit.release = () => {
            clearTimeout(timer)
            callback(...callbackArgs)
          }
          return timer
        }
        return target(...args)
      }
    })
    return commit
  })
  await orcaPage.keyboard.press('End')
  await orcaPage.keyboard.type('X')
  await expect(surfaces.first().locator('.view-lines')).toHaveText('print("SCROLL_CELL_0")X')
  await expect.poll(() => draftCommit.evaluate((commit) => typeof commit.release)).toBe('function')
  await orcaPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await orcaPage.mouse.wheel(0, 500)
  const scrolled = await notebook.evaluate(async (node, commit) => {
    for (let frame = 0; frame < 30; frame += 1) {
      if (node.scrollTop > 0) {
        const release = commit.release
        if (typeof release !== 'function') {
          throw new Error('Notebook source commit was not captured')
        }
        const position = node.scrollTop
        release()
        delete commit.release
        return position
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    throw new Error('Native wheel did not scroll the notebook')
  }, draftCommit)
  await draftCommit.dispose()
  await expect
    .poll(() =>
      orcaPage.evaluate((filePath) => {
        const state = window.__store?.getState()
        const file = state?.openFiles.find((candidate) => candidate.filePath === filePath)
        return file ? state?.editorDrafts[file.id] : undefined
      }, filePath)
    )
    .toContain(')X')
  await orcaPage.screenshot({ path: testInfo.outputPath('notebook-scroll-position.png') })
  await expect.poll(() => notebook.evaluate((node) => node.scrollTop)).toBe(scrolled)
})
