import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowsSecurity, FAKE_USER_SID } from './windows-security-addon.test-fixture'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from './windows-security-addon'
import { readPrivateWindowsFile } from './secure-path-windows-acl'
import { writeCredentialFileAtomic } from '../main/integration-credential-file'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  resetWindowsSecurityLoadForTests()
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
describe('Windows private credential-file contract', () => {
  it('reads once and traverses at most twice the ACE population at N and 10N', () => {
    const fake = createFakeWindowsSecurity()
    setWindowsSecurityForTests(fake)
    const reads = vi.spyOn(fake, 'readFileWithDacl')
    for (const count of [16, 160]) {
      let visits = 0
      const aces = Array.from({ length: count }, () => ({
        get type() {
          visits++
          return 0
        },
        flags: 0x10,
        mask: 0x1f01ff,
        sid: FAKE_USER_SID
      }))
      reads.mockReturnValue({ data: Buffer.from('fixture-only'), dacl: { protected: false, aces } })
      reads.mockClear()
      expect(readPrivateWindowsFile('owned-fixture', 100)?.toString()).toBe('fixture-only')
      expect(reads).toHaveBeenCalledTimes(1)
      expect(visits).toBe(2 * count)
    }
  })
  it('reads inherited private CLI files and rejects foreign access without changing their DACL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-private-credential-'))
    roots.push(dir)
    const path = join(dir, 'token')
    writeFileSync(path, 'fixture-only')
    const fake = createFakeWindowsSecurity()
    setWindowsSecurityForTests(fake)
    fake.dacls.set(path, `D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${FAKE_USER_SID})`)
    expect(readPrivateWindowsFile(path, 100)?.toString()).toBe('fixture-only')
    fake.dacls.set(path, `D:AI(A;ID;FA;;;${FAKE_USER_SID})(A;ID;FR;;;WD)`)
    expect(() => readPrivateWindowsFile(path, 100)).toThrow('another user')
    expect(fake.callsFor('set')).toEqual([])
  })
  it('preserves the prior credential and leaves no staging bytes without enforced protection', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const dir = mkdtempSync(join(tmpdir(), 'orca-private-publish-'))
    roots.push(dir)
    const path = join(dir, 'token')
    writeFileSync(path, 'prior')
    setWindowsSecurityForTests(null)
    expect(() =>
      writeCredentialFileAtomic(path, Buffer.from('fixture-only'), undefined, true)
    ).toThrow('protection is unavailable')
    expect(readFileSync(path, 'utf8')).toBe('prior')
    expect(readdirSync(dir)).toEqual(['token'])
  })
})
