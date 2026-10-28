import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { LAYOUT_OWNER_BUILD } from './helpers/layout-owner-build'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import { buildOwnedEditorFileId } from '../../src/renderer/src/store/slices/editor/file-ids/editor-file-ids'

test('isolates reading positions for restored same-path editor owners', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.skip(LAYOUT_OWNER_BUILD, 'Exercises saved-session hydration in the window-owned layout')
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1400, height: 850 })
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = path.join(context.rootPath, `owner-view-state-${randomUUID()}.txt`)
  const textFor = (owner: string) =>
    [
      ...Array.from({ length: 400 }, (_, index) => `${owner} OWNER LINE ${index + 1}`),
      `${owner} OWNER END`
    ].join('\n')
  const localContent = textFor('LOCAL')
  const remoteContent = textFor('REMOTE')
  await writeFile(filePath, localContent, 'utf8')
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
  const localId = filePath
  const remoteId = buildOwnedEditorFileId(filePath, context.worktreeId, 'reading-position-host')

  const groupId = randomUUID()
  const worktreeId = context.worktreeId
  const persistedFile = {
    filePath,
    relativePath: path.basename(filePath),
    worktreeId,
    language: 'plaintext'
  }
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: worktreeId,
    openFilesByWorktree: {
      [worktreeId]: [
        { ...persistedFile, runtimeEnvironmentId: null, dirtyDraftContent: localContent },
        {
          ...persistedFile,
          runtimeEnvironmentId: 'reading-position-host',
          dirtyDraftContent: remoteContent
        }
      ]
    },
    activeFileIdByWorktree: { [worktreeId]: localId },
    activeTabTypeByWorktree: { [worktreeId]: 'editor' },
    unifiedTabs: {
      [worktreeId]: [localId, remoteId].map((id, sortOrder) => ({
        id,
        entityId: id,
        groupId,
        worktreeId,
        contentType: 'editor',
        label: path.basename(filePath),
        customLabel: null,
        color: null,
        sortOrder,
        createdAt: Date.now()
      }))
    },
    tabGroups: {
      [worktreeId]: [
        { id: groupId, worktreeId, activeTabId: localId, tabOrder: [localId, remoteId] }
      ]
    },
    tabGroupLayouts: { [worktreeId]: { type: 'leaf', groupId } },
    activeGroupIdByWorktree: { [worktreeId]: groupId }
  }

  // Use startup's public hydration actions to restore file-ID tabs and dirty buffers.
  await orcaPage.evaluate(
    ({ session, remoteId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Editor store unavailable')
      }
      store.getState().hydrateTabsSession(session)
      store.getState().hydrateEditorSession(session)
      // Keep distinct host provenance while reading the fixture through local transport.
      store.setState((state) => ({
        openFiles: state.openFiles.map((file) =>
          file.id === remoteId
            ? {
                ...file,
                runtimeEnvironmentId: undefined,
                operationProvenance: {
                  ownershipProjection: 'explicit' as const,
                  generation: {
                    route: {
                      executionHostId: 'ssh:reading-position-host',
                      runtimeEnvironmentId: null
                    },
                    runtimeConnectionGeneration: null,
                    runtimePairingRevision: undefined,
                    runtimeSshGeneration: null,
                    nestedSshGeneration: null,
                    directSshGeneration: null
                  }
                }
              }
            : file
        )
      }))
    },
    { session, remoteId }
  )
  await expect
    .poll(() =>
      orcaPage.evaluate(
        ({ localId, remoteId, worktreeId }) => {
          const state = window.__store?.getState()
          return [localId, remoteId].every((id) =>
            state?.unifiedTabsByWorktree[worktreeId]?.some(
              (tab) => tab.id === id && tab.entityId === id
            )
          )
        },
        { localId, remoteId, worktreeId }
      )
    )
    .toBe(true)

  const editor = orcaPage.locator('.monaco-editor').first()
  await expect(editor).toBeVisible({ timeout: 25_000 })
  const snapshot = () => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot())
  const selectLine = async (query: string, line: number) => {
    await editor.click()
    await orcaPage.keyboard.press('ControlOrMeta+f')
    const find = editor.locator('.find-widget .input[aria-label="Find"]')
    await find.fill(query)
    await orcaPage.keyboard.press('Enter')
    await orcaPage.keyboard.press('Escape')
    await expect
      .poll(async () => (await snapshot())?.selection?.selectionStartLineNumber)
      .toBe(line)
    let previousScrollTop = -1
    await expect
      .poll(async () => {
        const current = await snapshot()
        const scrollTop = current?.scrollTop ?? -1
        const lineVisible = current?.visibleRanges.some(
          (range) => range.startLineNumber <= line && range.endLineNumber >= line
        )
        const settled = lineVisible && scrollTop > 0 && scrollTop === previousScrollTop
        previousScrollTop = scrollTop
        return settled
      })
      .toBe(true)
    return snapshot()
  }
  const switchOwner = async (id: string, owner: string) => {
    const selector = await orcaPage.evaluate((id) => `[data-tab-id="${CSS.escape(id)}"]`, id)
    await orcaPage.locator(selector).click()
    await expect.poll(async () => (await snapshot())?.valueTail).toBe(`${owner} OWNER END`)
    await orcaPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
  }
  await expect.poll(async () => (await snapshot())?.valueTail).toBe('LOCAL OWNER END')
  const localPosition = await selectLine('LOCAL OWNER LINE 120', 120)
  await orcaPage.screenshot({ path: testInfo.outputPath('local-owner-reading-position.png') })

  await switchOwner(remoteId, 'REMOTE')
  const initialRemote = await snapshot()
  await orcaPage.screenshot({ path: testInfo.outputPath('remote-owner-first-open.png') })
  expect
    .soft(initialRemote?.selection)
    .toMatchObject({ selectionStartLineNumber: 1, positionLineNumber: 1 })
  expect.soft(initialRemote?.scrollTop).toBe(0)
  const remotePosition = await selectLine('REMOTE OWNER LINE 240', 240)

  await switchOwner(localId, 'LOCAL')
  const returnedLocal = await snapshot()
  await orcaPage.screenshot({ path: testInfo.outputPath('local-owner-restored.png') })
  expect.soft(returnedLocal?.selection).toEqual(localPosition?.selection)
  expect.soft(returnedLocal?.scrollTop).toBe(localPosition?.scrollTop)

  await switchOwner(remoteId, 'REMOTE')
  const returnedRemote = await snapshot()
  const positionsPath = testInfo.outputPath('owner-reading-positions.json')
  await writeFile(
    positionsPath,
    JSON.stringify({ localPosition, initialRemote, remotePosition, returnedLocal, returnedRemote }),
    'utf8'
  )
  await testInfo.attach('owner-reading-positions', {
    path: positionsPath,
    contentType: 'application/json'
  })
  expect(returnedRemote?.selection).toEqual(remotePosition?.selection)
  expect(returnedRemote?.scrollTop).toBe(remotePosition?.scrollTop)
})
