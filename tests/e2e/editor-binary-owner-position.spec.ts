import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import { buildOwnedEditorFileId } from '../../src/renderer/src/store/slices/editor/file-ids/editor-file-ids'
import { LAYOUT_OWNER_BUILD } from './helpers/layout-owner-build'

test('keeps restored PDF positions independent between a worktree and a folder workspace', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.skip(LAYOUT_OWNER_BUILD, 'Exercises saved-session hydration in the window-owned layout')
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const folderPath = path.join(context.rootPath, `pdf-owner-${randomUUID()}`)
  const filePath = path.join(folderPath, 'shared-report.pdf')
  const scratchPath = path.join(folderPath, 'reading-break.txt')
  await mkdir(folderPath)
  await writeFile(scratchPath, 'Reading break\n')
  await writeFile(
    filePath,
    createPdfFindFixture({ title: 'Independent workspace reading positions' })
  )
  registerPostElectronShutdownCleanup(() => rm(folderPath, { recursive: true, force: true }))

  const folderWorktreeId = await orcaPage.evaluate(
    async ({ folderPath }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Missing fixture store')
      }
      const group = await window.api.projectGroups.create({
        name: 'PDF ownership fixture',
        parentPath: folderPath,
        createdFrom: 'folder-scan'
      })
      await state.fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
      const folder = await state.createFolderWorkspace(
        { projectGroupId: group.id, name: 'Independent PDF reader', folderPath },
        { runtimeEnvironmentId: null }
      )
      if (!folder) {
        throw new Error('Missing fixture folder')
      }
      return `folder:${folder.id}`
    },
    { folderPath }
  )
  const ids = {
    [context.worktreeId]: filePath,
    [folderWorktreeId]: buildOwnedEditorFileId(filePath, folderWorktreeId, null)
  }
  const groups = { [context.worktreeId]: randomUUID(), [folderWorktreeId]: randomUUID() }
  const owners = [context.worktreeId, folderWorktreeId]
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: context.worktreeId,
    openFilesByWorktree: Object.fromEntries(
      owners.map((worktreeId) => [
        worktreeId,
        [
          {
            filePath,
            relativePath: 'shared-report.pdf',
            worktreeId,
            language: 'plaintext',
            runtimeEnvironmentId: null
          }
        ]
      ])
    ),
    activeFileIdByWorktree: ids,
    activeTabTypeByWorktree: Object.fromEntries(
      owners.map((worktreeId) => [worktreeId, 'editor' as const])
    ),
    unifiedTabs: Object.fromEntries(
      owners.map((worktreeId) => [
        worktreeId,
        [
          {
            id: ids[worktreeId],
            entityId: ids[worktreeId],
            groupId: groups[worktreeId],
            worktreeId,
            contentType: 'editor' as const,
            label: 'shared-report.pdf',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: Date.now()
          }
        ]
      ])
    ),
    tabGroups: Object.fromEntries(
      owners.map((worktreeId) => [
        worktreeId,
        [
          {
            id: groups[worktreeId],
            worktreeId,
            activeTabId: ids[worktreeId],
            tabOrder: [ids[worktreeId]]
          }
        ]
      ])
    ),
    tabGroupLayouts: Object.fromEntries(
      owners.map((worktreeId) => [
        worktreeId,
        { type: 'leaf' as const, groupId: groups[worktreeId] }
      ])
    ),
    activeGroupIdByWorktree: groups
  }
  await orcaPage.evaluate((session) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Missing fixture store')
    }
    state.hydrateTabsSession(session)
    state.hydrateEditorSession(session)
  }, session)
  const openPdf = async (worktreeId: string) => {
    await orcaPage.evaluate(
      (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId),
      worktreeId
    )
    const id = ids[worktreeId]
    const selector = await orcaPage.evaluate((id) => `[data-tab-id="${CSS.escape(id)}"]`, id)
    await orcaPage.locator(selector).click()
    await expect(orcaPage.locator('.pdfViewer:visible')).toHaveCount(1)
    await expect(orcaPage.locator('.pdfViewer:visible .page')).toHaveCount(3)
    await expect(orcaPage.locator('.pdfViewer:visible')).toContainText(
      'Independent workspace reading positions'
    )
    await orcaPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
  }
  const parkPdf = async (worktreeId: string) => {
    await orcaPage.evaluate(
      ({ worktreeId, scratchPath }) => {
        window.__store?.getState().openFile(
          {
            worktreeId,
            filePath: scratchPath,
            relativePath: 'reading-break.txt',
            language: 'plaintext',
            mode: 'edit',
            runtimeEnvironmentId: null
          },
          { preview: false }
        )
      },
      { worktreeId, scratchPath }
    )
    await expect(orcaPage.locator('.pdfViewer:visible')).toHaveCount(0)
  }
  const snapshot = () =>
    orcaPage.locator('.pdfViewer:visible').evaluate((viewer) => {
      const container = viewer.parentElement
      if (!container) {
        throw new Error('Missing PDF scroll container')
      }
      return { scrollTop: container.scrollTop, scrollLeft: container.scrollLeft }
    })
  const scrollToPage = async (pageNumber: number) => {
    await orcaPage
      .locator(`.pdfViewer:visible .page[data-page-number="${pageNumber}"]`)
      .evaluate((page) => {
        const container = page.parentElement?.parentElement
        if (!(page instanceof HTMLElement) || !container) {
          throw new Error('Missing PDF page container')
        }
        container.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }))
        container.scrollTop = page.offsetTop + 100
      })
    await expect.poll(async () => (await snapshot()).scrollTop).toBeGreaterThan(500)
    await orcaPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    return snapshot()
  }

  await openPdf(context.worktreeId)
  const worktreePosition = await scrollToPage(2)
  await orcaPage.screenshot({ path: testInfo.outputPath('worktree-page-two.png') })
  await parkPdf(context.worktreeId)
  await openPdf(folderWorktreeId)
  const folderInitial = await snapshot()
  await orcaPage.screenshot({ path: testInfo.outputPath('folder-first-open.png') })
  expect.soft(folderInitial.scrollTop).toBe(0)
  const folderPosition = await scrollToPage(3)
  await parkPdf(folderWorktreeId)

  await openPdf(context.worktreeId)
  const returnedWorktree = await snapshot()
  await orcaPage.screenshot({ path: testInfo.outputPath('worktree-restored.png') })
  expect.soft(returnedWorktree.scrollTop).toBeCloseTo(worktreePosition.scrollTop, 0)
  await parkPdf(context.worktreeId)
  await openPdf(folderWorktreeId)
  const returnedFolder = await snapshot()
  expect.soft(returnedFolder.scrollTop).toBeCloseTo(folderPosition.scrollTop, 0)
  await writeFile(
    testInfo.outputPath('pdf-owner-positions.json'),
    JSON.stringify(
      { worktreePosition, folderInitial, folderPosition, returnedWorktree, returnedFolder },
      null,
      2
    )
  )
})
