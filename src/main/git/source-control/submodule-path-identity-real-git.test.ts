import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { getDiff } from './file-diff'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'
import { listSubmodulePaths } from './submodule-paths'
import { getSubmoduleStatus } from './submodule-status'
import { getStatus } from './status-read'

let directory: string
const original = 'tracked original\nunchanged context\n'
const modified = 'edited working copy\nunchanged context\n'

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout
}

async function init(repository: string): Promise<void> {
  await mkdir(repository)
  await git(repository, 'init', '-q')
  await git(repository, 'config', 'user.name', 'Test')
  await git(repository, 'config', 'user.email', 'test@example.test')
  await git(repository, 'config', 'commit.gpgsign', 'false')
  await git(repository, 'config', 'core.hooksPath', '')
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-submodule-path-'))
  invalidateGitReadCaches()
})

afterEach(async () => {
  invalidateGitReadCaches()
  await rm(directory, { recursive: true, force: true })
})

const cases = [
  { name: 'ordinary', path: 'vendor' },
  { name: 'name with spaces', path: 'vendor' },
  { name: 'name\twith\ttabs', path: 'vendor' },
  { name: 'internal-space', path: 'vendor module' },
  { name: 'leading-space', path: ' vendor' },
  ...(process.platform === 'win32'
    ? []
    : [
        { name: 'trailing-space', path: 'vendor ' },
        { name: 'newline-path', path: 'vendor\nmodule' }
      ])
]

describe('submodule path identity through status and diff reads', () => {
  it.each(cases)('opens tracked bytes for $name at "$path"', async ({ name, path }) => {
    const source = join(directory, 'source')
    const parent = join(directory, 'parent')
    await init(source)
    await writeFile(join(source, 'file.txt'), original)
    await git(source, 'add', '.')
    await git(source, 'commit', '-qm', 'initial')
    await init(parent)
    await git(parent, 'clone', '-q', source, path)
    await git(parent, 'config', '--file', '.gitmodules', `submodule.${name}.path`, path)
    await git(parent, 'config', '--file', '.gitmodules', `submodule.${name}.url`, source)
    await git(parent, 'add', '--', '.gitmodules', `:(literal)${path}`)
    await git(parent, 'commit', '-qm', 'submodule')
    const child = join(parent, path)
    const oid = (await git(child, 'rev-parse', 'HEAD')).trim()
    await writeFile(join(child, 'file.txt'), modified)

    expect(await git(child, 'show', ':file.txt')).toBe(original)
    expect((await getStatus(parent)).entries).toEqual([
      expect.objectContaining({ path, area: 'unstaged', submodule: expect.any(Object) })
    ])
    expect((await getSubmoduleStatus(parent, path)).entries).toEqual([
      expect.objectContaining({ path: 'file.txt', area: 'unstaged', status: 'modified' })
    ])
    expect(await getDiff(parent, `${path}/file.txt`, false)).toMatchObject({
      kind: 'text',
      originalContent: original,
      modifiedContent: modified
    })
    expect(await getDiff(parent, path, false)).toMatchObject({
      kind: 'text',
      originalContent: `Subproject commit ${oid}\n`,
      modifiedContent: `Subproject commit ${oid}\n`
    })
    expect(await listSubmodulePaths(parent)).toEqual([path])
    expect(await readFile(join(child, 'file.txt'), 'utf8')).toBe(modified)
  })
})

installRealWorkerThreadChildProcesses()
