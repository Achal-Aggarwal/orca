import { readdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type * as Monaco from 'monaco-editor'
import { runProcess } from '@orca/process-host'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('conflict navigation moves only the split pane whose button was pressed', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1600, height: 900 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'conflict-navigation.ts'
  const filePath = path.join(context.rootPath, relativePath)
  const lines = Array.from({ length: 220 }, (_, index) => `// Context line ${index + 1}`)
  for (const line of [81, 181]) {
    lines.splice(
      line - 1,
      5,
      '<<<<<<< HEAD',
      `const ours${line} = true`,
      '=======',
      `const theirs${line} = true`,
      '>>>>>>> incoming'
    )
  }
  await writeFile(filePath, lines.join('\n'))
  const git = async (args: string[], input?: string): Promise<string> => {
    const result = await runProcess({ program: 'git', args, cwd: context.rootPath, input })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  registerPostElectronShutdownCleanup(async () => {
    await git(['update-index', '--force-remove', '--', relativePath])
    await rm(filePath, { force: true })
  })
  const objectIds = await Promise.all(
    ['base', 'ours', 'theirs'].map((text) => git(['hash-object', '-w', '--stdin'], text))
  )
  await git(
    ['update-index', '--index-info'],
    objectIds.map((oid, index) => `100644 ${oid} ${index + 1}\t${relativePath}\n`).join('')
  )
  await orcaPage.evaluate(
    ({ context, relativePath }) => {
      window.__store?.getState().openConflictFile(
        context.worktreeId,
        context.rootPath,
        {
          path: relativePath,
          status: 'modified',
          area: 'unstaged',
          conflictKind: 'both_modified',
          conflictStatus: 'unresolved',
          conflictStatusSource: 'git'
        },
        'typescript',
        { preview: false }
      )
    },
    { context, relativePath }
  )
  await expect(orcaPage.locator('.monaco-editor')).toBeVisible()
  const split = await orcaPage.evaluate((id) => {
    const state = window.__store?.getState()
    const tab = state?.getActiveTab(id)
    if (!state || !tab) {
      throw new Error('Expected an active conflict editor')
    }
    const siblingGroupId = state.createEmptySplitGroup(id, tab.groupId, 'right')
    if (!siblingGroupId) {
      throw new Error('Expected a split group')
    }
    state.createUnifiedTab(id, tab.contentType, {
      entityId: tab.entityId,
      label: tab.label,
      targetGroupId: siblingGroupId
    })
    return { targetGroupId: tab.groupId, siblingGroupId }
  }, context.worktreeId)
  await expect(orcaPage.locator('.monaco-editor')).toHaveCount(2)
  const assets = await readdir(path.join(process.cwd(), 'out/renderer/assets'))
  const monacoAsset = assets.find(
    (name) => name.startsWith('monaco-setup-') && name.endsWith('.js')
  )
  if (!monacoAsset) {
    throw new Error('Expected bundled Monaco setup module')
  }
  const editors = await orcaPage.evaluateHandle(async (asset) => {
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
    const candidates = monaco?.editor
      .getEditors()
      .filter(
        (editor) =>
          editor.getContainerDomNode().isConnected &&
          editor.getModel()?.getValue().includes('const ours81 = true')
      )
      .sort(
        (left, right) =>
          left.getContainerDomNode().getBoundingClientRect().left -
          right.getContainerDomNode().getBoundingClientRect().left
      )
    if (candidates?.length !== 2 || !candidates[0] || !candidates[1]) {
      throw new Error('Expected both mounted split editors')
    }
    return { target: candidates[0], sibling: candidates[1] }
  }, monacoAsset)
  const cursor = () =>
    editors.evaluate(({ target, sibling }) => ({
      target: target.getPosition()?.lineNumber,
      sibling: sibling.getPosition()?.lineNumber
    }))
  await expect.poll(cursor).toEqual({ target: 1, sibling: 1 })
  await orcaPage.screenshot({ path: testInfo.outputPath('before-conflict-navigation.png') })
  await orcaPage.getByRole('button', { name: 'Next conflict', exact: true }).first().click()
  await expect.poll(async () => (await cursor()).target).toBe(81)
  await orcaPage.screenshot({ path: testInfo.outputPath('after-conflict-navigation.png') })
  const after = await cursor()
  const evidence = { before: { target: 1, sibling: 1 }, after, split }
  const evidencePath = testInfo.outputPath('split-navigation.json')
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2))
  await testInfo.attach('split-navigation', { path: evidencePath, contentType: 'application/json' })
  expect(after).toEqual({ target: 81, sibling: 1 })
  await editors.dispose()
})
