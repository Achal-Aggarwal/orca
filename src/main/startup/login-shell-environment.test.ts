import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureLoginShellEnvironment,
  resetLoginShellEnvironmentCacheForTests,
  resolveLoginShellEnvironment
} from './login-shell-environment'

const originalHome = process.env.HOME
const originalZdotdir = process.env.ZDOTDIR
const SHELL_ONLY_VARIABLE = 'ORCA_TEST_LOGIN_SHELL_ONLY'
const originalShellOnlyValue = process.env[SHELL_ONLY_VARIABLE]
let testHome: string | null = null

// Choose an installed real shell with its login profile: Linux CI may lack zsh, and login bash reads .bash_profile rather than .bashrc.
const REAL_SHELL_CANDIDATES = [
  { path: '/bin/zsh', profileFile: '.zshenv' },
  { path: '/bin/bash', profileFile: '.bash_profile' }
] as const

const realShell = REAL_SHELL_CANDIDATES.find((candidate) => existsSync(candidate.path)) ?? null

afterEach(async () => {
  resetLoginShellEnvironmentCacheForTests()
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalZdotdir === undefined) {
    delete process.env.ZDOTDIR
  } else {
    process.env.ZDOTDIR = originalZdotdir
  }
  if (originalShellOnlyValue === undefined) {
    delete process.env[SHELL_ONLY_VARIABLE]
  } else {
    process.env[SHELL_ONLY_VARIABLE] = originalShellOnlyValue
  }
  if (testHome) {
    await rm(testHome, { recursive: true, force: true })
    testHome = null
  }
})

describe('resolveLoginShellEnvironment', () => {
  it('returns variables exported by the profile-loading shell', async () => {
    const spawner = vi.fn(async () => ({
      ...process.env,
      EXAMPLE_GATEWAY_TOKEN: 'shell-exported'
    }))

    await expect(
      resolveLoginShellEnvironment({ shellOverride: '/bin/zsh', spawner })
    ).resolves.toMatchObject({ EXAMPLE_GATEWAY_TOKEN: 'shell-exported' })
  })

  it.runIf(realShell !== null)(
    'captures a profile export missing from the parent process',
    async () => {
      const shell = realShell!
      testHome = await mkdtemp(join(tmpdir(), 'orca-login-shell-env-'))
      await writeFile(
        join(testHome, shell.profileFile),
        `export ${SHELL_ONLY_VARIABLE}=shell-only\n`
      )
      process.env.HOME = testHome
      // zsh reads .zshenv from ZDOTDIR when set; harmless for the bash variant.
      process.env.ZDOTDIR = testHome
      delete process.env[SHELL_ONLY_VARIABLE]

      const environment = await resolveLoginShellEnvironment({
        shellOverride: shell.path,
        startedAfter: Date.now()
      })
      expect(environment[SHELL_ONLY_VARIABLE]).toBe('shell-only')
    }
  )
})

it
  .skipIf(process.platform === 'win32')
  .each(REAL_SHELL_CANDIDATES.filter((shell) => existsSync(shell.path)))(
  'uses the launch cwd and a fresh profile, resolving only the actual external command (%j)',
  async (shell) => {
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'orca-launch-source-')))
    const cwd = join(testHome, 'pane'),
      bin = join(testHome, 'bin')
    await mkdir(cwd)
    await mkdir(bin)
    await symlink(process.execPath, join(bin, 'opencode'))
    const profile = join(testHome, shell.path.endsWith('zsh') ? '.zshrc' : shell.profileFile)
    const base = `export PATH='${bin}:/usr/bin:/bin'\nexport XDG_DATA_HOME="$PWD/first"\n`
    await writeFile(profile, base)
    const options = {
      shellOverride: shell.path,
      cwd,
      resolveCommand: 'opencode',
      env: { HOME: testHome, USERPROFILE: testHome, ZDOTDIR: testHome, PATH: '/usr/bin:/bin' }
    }
    const first = await captureLoginShellEnvironment({ ...options, startedAfter: Date.now() })
    expect(first).toMatchObject({
      status: 'captured',
      cwd,
      executablePath: join(bin, 'opencode'),
      env: { XDG_DATA_HOME: join(cwd, 'first') }
    })
    await writeFile(profile, base.replace('/first', '/second'))
    const changed = await captureLoginShellEnvironment({ ...options, startedAfter: Date.now() })
    expect(changed.env.XDG_DATA_HOME).toBe(join(cwd, 'second'))
    expect(changed.env.__ORCA_CAPTURE_EXECUTABLE).toBeUndefined()
    for (const opaque of ["alias opencode='other'", 'opencode() { command other "$@"; }']) {
      await writeFile(profile, `${base}${opaque}\n`)
      const capture = await captureLoginShellEnvironment({ ...options, startedAfter: Date.now() })
      expect(capture.status).toBe('captured')
      expect(capture.executablePath).toBeNull()
    }
  }
)
