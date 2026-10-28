import { runProcess, runProcessSync } from '@orca/process-host'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveGitCommonDirectory } from '../../shared/git-common-directory'
import { resolveGitDir } from './source-control/resolve-git-dir'
import { scanGitMarkerSync } from './repo-git-marker-scan'

const { asyncGit, syncGit } = vi.hoisted(() => ({ asyncGit: vi.fn(), syncGit: vi.fn() }))
vi.mock('./runner', () => ({ gitExecFileAsync: asyncGit, gitExecFileSync: syncGit }))

import {
  getGitRepoRoot,
  getGitRepoRootAsync,
  inspectGitRepoForRegistration,
  inspectGitRepoForRegistrationAsync
} from './repo-detection'

let root = ''
let checkout = ''
let nested = ''
let unavailableGit = false

function spec(args: string[], cwd = root) {
  return {
    program: 'git',
    args,
    cwd,
    timeoutMs: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'missing-config')
    }
  }
}

function output(result: { code: number | null; stdout: string; stderr: string }): string {
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr), { code: result.code })
  }
  return result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-gitfile-identity-')))
  checkout = join(root, 'checkout')
  nested = join(checkout, 'nested')
  await mkdir(nested, { recursive: true })
  unavailableGit = false
  asyncGit.mockImplementation(async (args: string[], options: { cwd: string }) => {
    if (unavailableGit) {
      throw Object.assign(new Error('Git executable unavailable'), { code: 'EACCES' })
    }
    const result = await runProcess(spec(args, options.cwd))
    output(result)
    return result
  })
  syncGit.mockImplementation((args: string[], options: { cwd: string }) => {
    if (unavailableGit) {
      throw Object.assign(new Error('Git executable unavailable'), { code: 'EACCES' })
    }
    return output(runProcessSync(spec(args, options.cwd)))
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function initMetadata(directory: string) {
  output(await runProcess(spec(['init', '--bare', '-q', directory])))
}

async function expectFallbackIdentity(isRepo: boolean) {
  unavailableGit = true
  const expected = { isRepo, rootPath: isRepo ? checkout : nested, mainRepoPath: null }
  expect(inspectGitRepoForRegistration(nested)).toEqual(expected)
  expect(await inspectGitRepoForRegistrationAsync(nested)).toEqual(expected)
  expect(getGitRepoRoot(nested)).toBe(expected.rootPath)
  expect(await getGitRepoRootAsync(nested)).toBe(expected.rootPath)
  unavailableGit = false
}

describe.skipIf(process.platform === 'win32')('Git-accepted gitfile payload identity', () => {
  it('follows complete relative and absolute paths instead of valid prefix siblings', async () => {
    for (const name of ['metadata', 'metadata ', 'metadata\nname']) {
      await initMetadata(join(root, name))
    }
    await initMetadata(join(checkout, ' metadata'))
    await initMetadata(join(checkout, '  '))
    for (const [payload, expected] of [
      ['../metadata', join(root, 'metadata')],
      ['../metadata ', join(root, 'metadata ')],
      ['../metadata\nname', join(root, 'metadata\nname')],
      [join(root, 'metadata\nname'), join(root, 'metadata\nname')],
      [' metadata', join(checkout, ' metadata')],
      ['  ', join(checkout, '  ')]
    ]) {
      await writeFile(join(checkout, '.git'), `gitdir: ${payload}\r\n\n`)
      expect(output(await runProcess(spec(['rev-parse', '--absolute-git-dir'], checkout)))).toBe(
        expected
      )
      expect(await resolveGitDir(checkout)).toBe(expected)
      expect(await resolveGitCommonDirectory(checkout)).toBe(expected)
      expect(scanGitMarkerSync(nested)).toEqual({ status: 'valid', rootPath: checkout })
      await expectFallbackIdentity(true)
    }
  })
})

it('rejects invalid marker prefixes accepted by the former permissive parser', async () => {
  await initMetadata(join(root, 'metadata'))
  for (const marker of [
    'gitdir:../metadata\n',
    'GITDIR: ../metadata\n',
    'gitdir:\t../metadata\n',
    'ignored\ngitdir: ../metadata\n',
    'gitdir: \r\n'
  ]) {
    await writeFile(join(checkout, '.git'), marker)
    expect((await runProcess(spec(['rev-parse', '--absolute-git-dir'], checkout))).code).not.toBe(0)
    expect(await resolveGitDir(checkout)).toBe(join(checkout, '.git'))
    expect(await resolveGitCommonDirectory(checkout)).toBeNull()
    expect(scanGitMarkerSync(nested)).toEqual({ status: 'invalid' })
    await expectFallbackIdentity(false)
  }
})

it('keeps an ordinary folder outside repository fallback', async () => {
  expect(await resolveGitCommonDirectory(checkout)).toBeNull()
  expect(scanGitMarkerSync(nested)).toEqual({ status: 'absent' })
  await expectFallbackIdentity(false)
})
