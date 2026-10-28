import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRemoteFileUrl } from './repo'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'

const directories: string[] = []
const filenames = [
  String.raw`odd\name.txt`,
  'odd/name.txt',
  String.raw`folder/odd\name.txt`,
  'folder/odd/name.txt',
  'ordinary file.txt'
]
const providers = [
  { host: 'github.com', repositoryPath: 'org/repo', fileRoute: 'blob', fragment: '#L7-L10' },
  { host: 'gitlab.com', repositoryPath: 'group/sub/repo', fileRoute: '-/blob', fragment: '#L7-10' },
  { host: 'bitbucket.org', repositoryPath: 'team/repo', fileRoute: 'src' }
]

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32').each(providers)(
  'remote file identity on $host',
  (provider) => {
    let directory: string
    let sha: string
    const git = async (...args: string[]) => {
      const result = await runProcess({ program: 'git', args, cwd: directory })
      if (result.code !== 0) {
        throw new Error(result.stderr)
      }
      return result.stdout
    }

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'orca-remote-file-path-'))
      directories.push(directory)
      await git('init', '-q')
      await git('symbolic-ref', 'HEAD', 'refs/heads/main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.test')
      await git('config', 'commit.gpgsign', 'false')
      await git('config', 'core.hooksPath', '')
      await mkdir(join(directory, 'odd'))
      await mkdir(join(directory, 'folder', 'odd'), { recursive: true })
      for (const [index, filename] of filenames.entries()) {
        await writeFile(join(directory, filename), `distinct file ${index}\n`)
      }
      await git('add', '--', ...filenames)
      await git('commit', '-qm', 'remote file fixture')
      sha = (await git('rev-parse', 'HEAD')).trim()
      await git(
        'remote',
        'add',
        'origin',
        `https://${provider.host}/${provider.repositoryPath}.git`
      )
      await git('update-ref', 'refs/remotes/origin/main', sha)
      await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
      await git('config', 'branch.main.remote', 'origin')
      await git('config', 'branch.main.merge', 'refs/heads/main')
    })

    it.each(filenames)('links to the committed bytes of %s', async (filename) => {
      const url = await getRemoteFileUrl(directory, filename, 7, 10)
      if (url === null) {
        throw new Error('Expected a published file URL')
      }
      const parsed = new URL(url)
      const prefix = `/${provider.repositoryPath}/${provider.fileRoute}/${sha}/`
      expect(parsed.pathname.startsWith(prefix)).toBe(true)
      const addressedPath = decodeURIComponent(parsed.pathname.slice(prefix.length))
      expect(addressedPath).toBe(filename)
      const requestedBytes = await readFile(join(directory, filename), 'utf8')
      expect(await git('show', `${sha}:${addressedPath}`)).toBe(requestedBytes)
      expect(parsed.hash).toBe(
        provider.fragment ?? `#${encodeURIComponent(`${filename.split('/').at(-1)}-7`)}:10`
      )
      expect(await git('status', '--porcelain')).toBe('')
    })
  }
)

installRealWorkerThreadChildProcesses()
