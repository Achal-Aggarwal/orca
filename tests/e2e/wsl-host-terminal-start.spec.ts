/**
 * Terminals on a WSL host whose distro stopped, with a fake WSL transport: the HUB stands in for
 * the distro's orcad. Automatic retries never boot the distro (E9); the pane's Start and a New
 * Terminal are the user acting on it, so each boots it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { callEnvironment } from './helpers/paired-host-terminal'
import { waitForSessionReady } from './helpers/store'
import {
  createGitProject,
  fakeWslConnects,
  focusProject,
  launchDesktopWithFakeWsl,
  readDistroState,
  RUNNING,
  STOPPED,
  WSL_ENVIRONMENT_ID,
  writeDistros
} from './helpers/wsl-host-fake-desktop'

async function openNewTerminal(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
  await page
    .getByRole('menuitem', { name: /New Terminal/ })
    .first()
    .click()
}

test('a stopped WSL distro boots only for Start or New Terminal, never for a terminal retrying', async ({
  orcaPage: hub
}, testInfo) => {
  test.setTimeout(300_000)
  await waitForSessionReady(hub)
  const offer = await createRuntimeDesktopPairingOffer(hub)
  const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-terminal-fake-'))
  const distrosFile = path.join(fakeDir, 'distros.json')
  const connectLogFile = path.join(fakeDir, 'connects.log')
  writeDistros(distrosFile, RUNNING)
  const desktop = await launchDesktopWithFakeWsl(
    { distros: RUNNING, distrosFile, connectLogFile, pairingCode: offer.pairingUrl },
    testInfo
  )
  const projectPath = createGitProject()
  try {
    const { page } = desktop
    await page.evaluate(async () => {
      const settings = await window.api.settings.set({ experimentalWslHosts: true })
      window.__store?.setState({ settings })
    })
    const added = await page.evaluate(() =>
      window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' })
    )
    expect(added, JSON.stringify(added)).toMatchObject({ ok: true })
    await callEnvironment(page, WSL_ENVIRONMENT_ID, 'repo.add', { path: projectPath, kind: 'git' })
    await expect.poll(() => focusProject(page, projectPath), { timeout: 60_000 }).toBeTruthy()

    const terminals = page.locator('.xterm')
    await openNewTerminal(page)
    await expect(terminals.first()).toBeVisible({ timeout: 60_000 })

    const stopDistro = async (): Promise<number> => {
      const connects = fakeWslConnects(connectLogFile).length
      writeDistros(distrosFile, STOPPED)
      await expect
        .poll(
          () =>
            callEnvironment(page, WSL_ENVIRONMENT_ID, 'files.readDir', {
              worktree: `path:${projectPath}`,
              relativePath: ''
            }).then(
              () => 'answered',
              (error: unknown) => String(error)
            ),
          { timeout: 30_000 }
        )
        .toContain('Ubuntu was stopped')
      return connects
    }
    // The shown tab's card; a background tab's stays in the DOM, hidden.
    const stoppedCard = page.locator(
      `[data-terminal-wsl-host-stopped="${WSL_ENVIRONMENT_ID}"]:visible`
    )

    const connectsBeforeStart = await stopDistro()
    await expect(stoppedCard.first()).toBeVisible({ timeout: 60_000 })
    await expect(stoppedCard.first()).toContainText('Ubuntu is stopped')
    // Whatever the pane retries in the background must not boot the distro.
    await page.waitForTimeout(10_000)
    expect(fakeWslConnects(connectLogFile)).toHaveLength(connectsBeforeStart)
    expect(readDistroState(distrosFile)).toBe('stopped')
    await page.screenshot({ path: testInfo.outputPath('wsl-host-terminal-stopped.png') })

    await stoppedCard.first().getByRole('button', { name: 'Start', exact: true }).click()
    await expect
      .poll(() => fakeWslConnects(connectLogFile).length, { timeout: 60_000 })
      .toBeGreaterThan(connectsBeforeStart)
    await expect(stoppedCard).toHaveCount(0, { timeout: 60_000 })
    await page.screenshot({ path: testInfo.outputPath('wsl-host-terminal-after-start.png') })

    // New Terminal on the stopped host is the user acting on it too.
    const connectsBeforeNewTerminal = await stopDistro()
    await expect(stoppedCard.first()).toBeVisible({ timeout: 60_000 })
    const terminalCount = await terminals.count()
    await openNewTerminal(page)
    await expect
      .poll(() => fakeWslConnects(connectLogFile).length, { timeout: 60_000 })
      .toBeGreaterThan(connectsBeforeNewTerminal)
    await expect.poll(() => terminals.count(), { timeout: 60_000 }).toBeGreaterThan(terminalCount)
    await expect(stoppedCard).toHaveCount(0, { timeout: 60_000 })
    await page.screenshot({ path: testInfo.outputPath('wsl-host-terminal-new-terminal.png') })
  } finally {
    await desktop.dispose()
    rmSync(fakeDir, { recursive: true, force: true })
    rmSync(projectPath, { recursive: true, force: true })
  }
})
