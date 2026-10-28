import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { prepareAntigravityAccountForLaunch } from './native-account-launch'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { getAntigravityAccountService } from './native-account-host'

const { prepareForLaunch } = vi.hoisted(() => ({ prepareForLaunch: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn(() => '') }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/task/home' })
}))
vi.mock('./native-account-store', () => ({ createEncryptedAntigravityAccountStore: vi.fn() }))
vi.mock('./native-account-host', () => ({
  getAntigravityAccountVaultPath: () => '/task/vault',
  getAntigravityAccountService: vi.fn(() => ({ prepareForLaunch }))
}))

beforeEach(() => {
  vi.mocked(existsSync).mockReset().mockReturnValue(true)
  vi.mocked(getAntigravityAccountService).mockClear()
  vi.mocked(createEncryptedAntigravityAccountStore).mockReturnValue({
    read: () => ({ accounts: [], selectedAccountId: 'selected' }),
    write: vi.fn()
  })
  prepareForLaunch.mockReset().mockResolvedValue(undefined)
})

describe('native account verification before agy launch', () => {
  it('preserves owning-host and distro boundaries without reading client credentials', async () => {
    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      connectionId: 'ssh-owner'
    })
    await prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity', isWsl: true })
    await prepareAntigravityAccountForLaunch({ launchAgent: 'codex' })
    expect(existsSync).not.toHaveBeenCalled()
    expect(getAntigravityAccountService).not.toHaveBeenCalled()
  })

  it('does not read native credentials when no account selection exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    await prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity' })
    expect(getAntigravityAccountService).not.toHaveBeenCalled()
  })

  it('blocks a launch using an overridden credential home without silently replacing its account', async () => {
    await expect(
      prepareAntigravityAccountForLaunch({
        launchAgent: 'antigravity',
        env: { HOME: '/other/authority' }
      })
    ).rejects.toThrow('different credential authority')
    expect(prepareForLaunch).not.toHaveBeenCalled()
  })

  it('rejects deleting the credential home before launch', async () => {
    await expect(
      prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity', envToDelete: ['HOME'] })
    ).rejects.toThrow('different credential authority')
    expect(prepareForLaunch).not.toHaveBeenCalled()
  })

  it('does not merge removed authority detectors back into a complete launch environment', async () => {
    vi.stubEnv('SSH_CLIENT', 'task-host')
    try {
      await expect(
        prepareAntigravityAccountForLaunch({
          launchAgent: 'antigravity',
          env: { HOME: '/task/home' },
          envIsComplete: true
        })
      ).rejects.toThrow('different credential authority')
      expect(prepareForLaunch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Windows native credential authority before launch', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('USERPROFILE', 'C:\\Users\\fixture')
    vi.stubEnv('HOME', 'C:\\irrelevant')
    for (const key of [
      'SSH_TTY',
      'SSH_CLIENT',
      'SSH_CONNECTION',
      'WSL_DISTRO_NAME',
      'WSL_INTEROP'
    ]) {
      vi.stubEnv(key, '')
    }
  })
  it('accepts case-insensitive equivalent USERPROFILE and removal of irrelevant HOME', async () => {
    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      env: { userprofile: 'c:/USERS/fixture/.' },
      envToDelete: ['home']
    })
    expect(prepareForLaunch).toHaveBeenCalledOnce()
  })
  it.each([
    { env: { userprofile: 'C:/other' } },
    { envToDelete: ['userprofile'] },
    { env: { HOME: 'C:/Users/fixture' }, envIsComplete: true },
    { command: 'agy --gemini_dir other' },
    { command: 'agy --app_data_dir=other' }
  ])('rejects a different actual Windows authority (%#)', async (overrides) => {
    await expect(
      prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity', ...overrides })
    ).rejects.toThrow(/credential authority|requires USERPROFILE/)
    expect(prepareForLaunch).not.toHaveBeenCalled()
  })
  it('accepts explicit default root flags without rewriting the command', async () => {
    await prepareAntigravityAccountForLaunch({
      command: 'agy --gemini_dir=.gemini --app_data_dir antigravity-cli'
    })
    expect(prepareForLaunch).toHaveBeenCalledOnce()
  })
  it('does not interpret an interactive prompt value as a storage flag', async () => {
    await prepareAntigravityAccountForLaunch({ command: 'agy --prompt-interactive "--gemini_dir"' })
    expect(prepareForLaunch).toHaveBeenCalledOnce()
  })
})
