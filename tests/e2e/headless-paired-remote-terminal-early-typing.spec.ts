import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedWebClient, type PairedWebClient } from './helpers/paired-electron-client'
import { focusActiveTerminalInput } from './helpers/terminal'

const ROUNDS = 3
const PROMPT = 'EARLY_TYPING_PROMPT$ '

async function terminalTabIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
    worktreeId
  )
}

function paneText(page: Page, tabId: string): Promise<string> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const buffer = (manager?.getActivePane?.() ?? manager?.getPanes?.()[0])?.terminal?.buffer.active
    if (!buffer) {
      return ''
    }
    const lines: string[] = []
    for (let row = 0; row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
  }, tabId)
}

function paneIsBound(page: Page, tabId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    return Boolean(pane?.container?.dataset?.ptyId)
  }, tabId)
}

// Keys typed into a new remote terminal after it binds, while the host shell's rc file still runs,
// must all reach that shell: its tty keeps type-ahead for readline, and nothing may drop a prefix.
test('keys typed into a new remote terminal before its first prompt all reach the shell', async ({
  testRepoPath
}) => {
  // Three host terminals, each held at its rc file until the keys are in, plus host and client boot.
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost({ extraEnv: { SHELL: '/bin/bash' } })
  const home = host.env.HOME ?? ''
  const release = path.join(home, '.orca-e2e-release-rc')
  mkdirSync(home, { recursive: true })
  // Each shell waits in its rc file for the release file (bounded at ~30s), so typing lands first.
  const rc = [
    'for _ in $(seq 600); do [ -f "$HOME/.orca-e2e-release-rc" ] && break; sleep 0.05; done',
    `PS1='${PROMPT}'`
  ].join('\n')
  writeFileSync(path.join(home, '.bash_profile'), `${rc}\n`)
  // Released until the rounds start: the host's own startup shell probes read this rc file too.
  writeFileSync(release, '')
  let client: PairedWebClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedWebClient(host.app, host.offer)
    const page = client.page
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id ?? null), {
        timeout: 30_000
      })
      .not.toBeNull()
    const worktreeId = await page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? ''
    )
    await page.evaluate((id) => {
      const state = window.__store!.getState()
      state.setActiveView('terminal')
      state.setActiveWorktree(id)
    }, worktreeId)

    for (let round = 0; round < ROUNDS; round += 1) {
      rmSync(release, { force: true })
      const before = new Set(await terminalTabIds(page, worktreeId))
      await page.evaluate(async (id) => {
        const state = window.__store!.getState()
        await state.openNewTerminalTabInActiveWorkspace(state.activeGroupIdByWorktree[id]!)
      }, worktreeId)
      let tabId = ''
      await expect
        .poll(async () => {
          tabId = (await terminalTabIds(page, worktreeId)).find((id) => !before.has(id)) ?? ''
          return tabId
        })
        .not.toBe('')
      // Type into this tab even if the worktree's own first terminal opened alongside it.
      await page.evaluate((id) => window.__store!.getState().setActiveTab(id), tabId)
      await expect.poll(() => paneIsBound(page, tabId), { timeout: 60_000 }).toBe(true)
      expect(await paneText(page, tabId)).not.toContain(PROMPT)

      await focusActiveTerminalInput(page)
      await page.keyboard.insertText(`echo EARLY_TYPING_${round}_$((40+2))`)
      await page.keyboard.press('Enter')
      expect(existsSync(release)).toBe(false)
      writeFileSync(release, '')

      await expect
        .poll(() => paneText(page, tabId), {
          timeout: 30_000,
          message: `round ${round}: the shell never ran the whole early-typed command`
        })
        .toMatch(new RegExp(`^EARLY_TYPING_${round}_42$`, 'm'))
    }
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
