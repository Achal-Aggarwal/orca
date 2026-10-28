import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeWindowsSecurity,
  daclFromSddl,
  FAKE_USER_SID,
  type FakeWindowsSecurity
} from '../../shared/windows-security-addon.test-fixture'
import {
  setWindowsSecurityForTests,
  resetWindowsSecurityLoadForTests
} from '../../shared/windows-security-addon'
import { hardenedDaclSddl } from '../../shared/windows-secure-dacl'
import { credential } from './native-account-test-fixtures'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'
import {
  readAntigravityWindowsCredential,
  writeAntigravityWindowsCredential
} from './native-windows-credentials'

let home: string
let fake: FakeWindowsSecurity
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-agy-windows-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  for (const key of ['SSH_TTY', 'SSH_CLIENT', 'SSH_CONNECTION', 'WSL_DISTRO_NAME', 'WSL_INTEROP']) {
    vi.stubEnv(key, '')
  }
  vi.stubEnv('USERPROFILE', home)
  fake = createFakeWindowsSecurity()
  setWindowsSecurityForTests(fake)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetWindowsSecurityLoadForTests()
  rmSync(home, { recursive: true, force: true })
})

describe('Windows native Antigravity credentials', () => {
  it('uses counted raw UTF-8 bytes at the CLI target, preserves fields, and verifies writes', async () => {
    const write = vi.spyOn(fake, 'writeGenericCredential')
    await writeAntigravityWindowsCredential(credential('テスト'))
    expect(write).toHaveBeenCalledWith(
      'gemini:antigravity',
      'antigravity',
      Buffer.from(credential('テスト'))
    )
    expect((await readAntigravityWindowsCredential())?.contents).toBe(credential('テスト'))
    write.mockImplementationOnce(() => {})
    await expect(writeAntigravityWindowsCredential(credential('b'))).rejects.toThrow(
      'could not be verified'
    )
  })

  it('separates absence and defined-empty records from inaccessible or corrupt native values', async () => {
    expect(await readAntigravityWindowsCredential()).toBeNull()
    fake.writeGenericCredential(
      'gemini:antigravity',
      'antigravity',
      Buffer.from('{"auth_method":"consumer","token":null}')
    )
    expect(await readAntigravityWindowsCredential()).toBeNull()
    fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from([255]))
    await expect(readAntigravityWindowsCredential()).rejects.toThrow('could not be read')
    fake.readGenericCredential = () => {
      throw new Error('fixture-secret')
    }
    await expect(readAntigravityWindowsCredential()).rejects.toThrow(
      /^The Antigravity Windows credential store could not be read\.$/
    )
    setWindowsSecurityForTests(null)
    await expect(readAntigravityWindowsCredential()).rejects.toThrow('could not be read')
  })

  it('rejects oversize UTF-8 credentials before touching the native store', async () => {
    const write = vi.spyOn(fake, 'writeGenericCredential')
    const contents = JSON.stringify({
      token: { access_token: 'テ'.repeat(900) },
      auth_method: 'consumer'
    })
    await expect(writeAntigravityWindowsCredential(contents)).rejects.toThrow('size limit')
    expect(write).not.toHaveBeenCalled()
  })

  it('creates native credentials when empty, preserves effective file fallback, and detects changes', async () => {
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    await backend.write(credential('a'), null)
    expect((await backend.read())?.contents).toBe(credential('a'))
    await expect(backend.write(credential('b'), null)).rejects.toThrow('changed during selection')
    const path = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, credential('b'))
    const read = fake.readFileWithDacl
    fake.readFileWithDacl = (path, max) => {
      const file = read(path, max)
      return file ? { ...file, dacl: daclFromSddl(hardenedDaclSddl(FAKE_USER_SID, false)) } : null
    }
    expect((await backend.read())?.contents).toBe(credential('a'))
    fake.readGenericCredential = () => {
      throw new Error('native unavailable')
    }
    await backend.write(credential('c'), credential('b'))
    expect(readFileSync(path, 'utf8')).toBe(credential('c'))
    expect((await backend.read())?.contents).toBe(credential('c'))
    fake.readGenericCredential = () => Buffer.from(credential('a'))
    expect((await backend.read())?.contents).toBe(credential('a'))
  })

  it('uses private file storage for Windows SSH bypass without native I/O', async () => {
    vi.stubEnv('SSH_CLIENT', 'fixture-host')
    fake.readGenericCredential = () => {
      throw new Error('must not use native')
    }
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    expect(await backend.read()).toBeNull()
    fake.readFileWithDacl = (path) => ({
      data: readFileSync(path),
      dacl: daclFromSddl(hardenedDaclSddl(FAKE_USER_SID, false))
    })
    await backend.write(credential('a'), null)
    expect((await backend.read())?.contents).toBe(credential('a'))
    fake.createFileWithDacl = () => {
      throw new Error('fixture-secret Win32 error 5')
    }
    await expect(backend.write(credential('b'), credential('a'))).rejects.toThrow(
      /^Antigravity could not update its credential file privately\. Check the file permissions and try again\.$/
    )
    expect((await backend.read())?.contents).toBe(credential('a'))
  })
})
