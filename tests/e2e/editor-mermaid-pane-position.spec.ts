import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('keeps Mermaid reading positions independent between split panes', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1600, height: 900 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = `diagram-${randomUUID()}.mmd`
  const filePath = path.join(context.rootPath, relativePath)
  const content = [
    'flowchart TD',
    ...Array.from(
      { length: 25 },
      (_, index) => `N${index}[Step ${index}] --> N${index + 1}[Step ${index + 1}]`
    )
  ].join('\n')
  await writeFile(filePath, content)
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
  const fileId = await orcaPage.evaluate(
    ({ context, filePath, relativePath }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Missing editor store')
      }
      const id = state.openFile(
        {
          worktreeId: context.worktreeId,
          filePath,
          relativePath,
          language: 'mermaid',
          mode: 'edit',
          runtimeEnvironmentId: null
        },
        { preview: false }
      )
      state.setMarkdownViewMode(id, 'rich')
      return id
    },
    { context, filePath, relativePath }
  )
  const viewers = orcaPage.locator('.mermaid-viewer:visible')
  await expect(viewers).toHaveCount(1)
  await expect(viewers.locator('svg')).toHaveCount(1, { timeout: 60_000 })
  await expect
    .poll(() => viewers.first().evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(1000)
  await viewers.first().evaluate((element) => {
    element.scrollTop = 600
  })
  await expect.poll(() => viewers.first().evaluate((element) => element.scrollTop)).toBe(600)
  await orcaPage.evaluate(
    (fileId) => window.__store?.getState().setMarkdownViewMode(fileId, 'source'),
    fileId
  )
  await expect(viewers).toHaveCount(0)
  const split = await orcaPage.evaluate(
    ({ worktreeId, fileId }) => {
      const state = window.__store?.getState()
      const tab = state?.getActiveTab(worktreeId)
      if (!state || !tab) {
        throw new Error('Missing diagram tab')
      }
      const siblingGroupId = state.createEmptySplitGroup(worktreeId, tab.groupId, 'right')
      if (!siblingGroupId) {
        throw new Error('Missing split group')
      }
      const sibling = state.createUnifiedTab(worktreeId, tab.contentType, {
        entityId: tab.entityId,
        label: tab.label,
        targetGroupId: siblingGroupId
      })
      state.setMarkdownViewMode(fileId, 'rich')
      return { originalTabId: tab.id, siblingTabId: sibling?.id }
    },
    { worktreeId: context.worktreeId, fileId }
  )
  await expect(viewers).toHaveCount(2)
  await expect(viewers.locator('svg')).toHaveCount(2, { timeout: 60_000 })
  await expect.poll(() => viewers.first().evaluate((element) => element.scrollTop)).toBe(600)
  const positions = await viewers.evaluateAll((elements) =>
    elements.map((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }))
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('split-diagram-positions.png') })
  await writeFile(
    testInfo.outputPath('diagram-positions.json'),
    JSON.stringify({ split, positions }, null, 2)
  )
  expect(positions.map((position) => position.scrollTop)).toEqual([600, 0])
})
