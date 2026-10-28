import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { validateGitRelativeFilePath } from '../../ipc/filesystem/filesystem-path-containment'
import { gitExecFileAsync } from '../runner'
import { getDiff } from './file-diff'
import { getSubmoduleStatus } from './submodule-status'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe.skipIf(process.platform === 'win32')('submodule pathname routing with real Git', () => {
  it.each(['ordinary', 'vendor\\module'])(
    'keeps %j inner and pointer diffs separate from parent neighbors',
    async (submodulePath) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-submodule-routing-'))
      directories.push(root)
      const source = join(root, 'source')
      const parent = join(root, 'parent')
      const child = join(parent, submodulePath)
      const git = async (cwd: string, ...args: string[]) => {
        const result = await runProcess({
          program: 'git',
          args,
          cwd,
          timeoutMs: 10_000,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: join(root, 'missing-config')
          }
        })
        expect(result.code, result.stderr).toBe(0)
        return result.stdout
      }
      const init = async (repo: string) => {
        await mkdir(repo)
        await git(repo, 'init', '-q')
        await git(repo, 'config', 'user.name', 'Test')
        await git(repo, 'config', 'user.email', 'test@example.test')
        await git(repo, 'config', 'commit.gpgsign', 'false')
        await git(repo, 'config', 'core.hooksPath', '')
      }
      await init(source)
      await writeFile(join(source, 'file.txt'), 'child original\n')
      await git(source, 'add', '.')
      await git(source, 'commit', '-qm', 'base')
      const base = (await git(source, 'rev-parse', 'HEAD')).trim()
      await init(parent)
      const setupVersion = (await git(parent, '--version')).trim()
      const executedVersion = (await gitExecFileAsync(['--version'], { cwd: parent })).stdout.trim()
      expect(executedVersion).toBe(setupVersion)
      await git(parent, 'clone', '-q', source, submodulePath)
      await git(child, 'config', 'user.name', 'Test')
      await git(child, 'config', 'user.email', 'test@example.test')
      await git(child, 'config', 'commit.gpgsign', 'false')
      await git(child, 'config', 'core.hooksPath', '')
      await git(parent, 'config', '--file', '.gitmodules', 'submodule.child.path', submodulePath)
      await git(parent, 'config', '--file', '.gitmodules', 'submodule.child.url', source)
      await mkdir(join(parent, 'vendor', 'module'), { recursive: true })
      await writeFile(join(parent, 'vendor', 'module', 'file.txt'), 'parent neighbor\n')
      await git(parent, 'add', '.')
      await git(parent, 'commit', '-qm', 'submodule and neighbor')
      await writeFile(join(child, 'file.txt'), 'child working\n')
      const filePath = validateGitRelativeFilePath(parent, `${submodulePath}/file.txt`)
      const parentIndex = await readFile(join(parent, '.git/index'))
      const childIndex = await readFile(join(child, '.git/index'))

      expect((await getSubmoduleStatus(parent, submodulePath)).entries).toContainEqual(
        expect.objectContaining({ path: 'file.txt', status: 'modified' })
      )
      expect(await getDiff(parent, filePath, false)).toMatchObject({
        originalContent: 'child original\n',
        modifiedContent: 'child working\n'
      })
      expect(await getDiff(parent, submodulePath, false)).toMatchObject({
        originalContent: `Subproject commit ${base}\n`,
        modifiedContent: `Subproject commit ${base}\n`
      })
      expect(await readFile(join(parent, '.git/index'))).toEqual(parentIndex)
      expect(await readFile(join(child, '.git/index'))).toEqual(childIndex)

      await git(child, 'add', '.')
      await git(child, 'commit', '-qm', 'child change')
      const head = (await git(child, 'rev-parse', 'HEAD')).trim()
      await git(parent, 'add', '--', `:(literal)${submodulePath}`)
      const stagedParentIndex = await readFile(join(parent, '.git/index'))
      const committedChildIndex = await readFile(join(child, '.git/index'))
      expect(await getDiff(parent, filePath, true)).toMatchObject({
        originalContent: 'child original\n',
        modifiedContent: 'child working\n'
      })
      expect(await getDiff(parent, submodulePath, true)).toMatchObject({
        originalContent: `Subproject commit ${base}\n`,
        modifiedContent: `Subproject commit ${head}\n`
      })
      expect(await readFile(join(parent, '.git/index'))).toEqual(stagedParentIndex)
      expect(await readFile(join(child, '.git/index'))).toEqual(committedChildIndex)
      expect(await readFile(join(parent, 'vendor', 'module', 'file.txt'), 'utf8')).toBe(
        'parent neighbor\n'
      )
    }
  )
})
