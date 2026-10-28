import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import Database from '../sqlite/sync-database'
import { writeOpenCodeSqliteDatabase } from '../ai-vault/session-scanner-opencode-sqlite-fixture'
import { readOpenCodeSessionPresence } from './opencode-session-presence'
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) }
})
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sta-11913-store-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
function legacyRow(projectID: string, directory = '/work') {
  return JSON.stringify({
    id: 'ses_kept',
    projectID,
    directory,
    version: '1.1.1',
    time: { created: 1, updated: 2 }
  })
}
it.each(['legacy', 'v1', 'v2'] as const)(
  '%s exact metadata includes an empty session and distinguishes deletion',
  async (kind) => {
    const dbPath = join(root, 'custom.db')
    const source =
      kind === 'legacy'
        ? { root, cwd: root, env: {}, api: 'v1' as const, storage: 'legacy' as const }
        : {
            root,
            dbPath,
            api: kind === 'v2' ? ('v2' as const) : ('v1' as const),
            storage: 'sqlite' as const
          }
    if (kind === 'legacy') {
      const dir = join(root, 'storage', 'session', 'global')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'ses_kept.json'), legacyRow('global'))
      // A newer unrelated database must never select a legacy CLI's authority.
      writeOpenCodeSqliteDatabase(dbPath, [])
    } else {
      writeOpenCodeSqliteDatabase(dbPath, [{ id: 'ses_kept', directory: '/work', turns: [] }])
      if (kind === 'v2') {
        const db = new Database(dbPath)
        // Recorded v2 metadata columns; no message or transcript is needed to establish presence.
        db.exec(`
          CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
          CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO session_v2 VALUES ('ses_kept', 'project', '/work', 1, 2);
          INSERT INTO kv VALUES ('migration.v1-v2', '{"phase":"completed"}');
        `)
        db.close()
      }
    }
    expect(await readOpenCodeSessionPresence(source, 'ses_kept')).toBe('present')
    expect(await readOpenCodeSessionPresence(source, 'ses_deleted')).toBe('absent')
    if (kind === 'v2') {
      const db = new Database(dbPath)
      db.exec('DELETE FROM session_v2')
      db.close()
      expect(await readOpenCodeSessionPresence(source, 'ses_kept')).toBe('absent')
    }
  }
)
it('keeps unknown, malformed, locked, and unfinished migration sources unavailable', async () => {
  const dbPath = join(root, 'opencode.db'),
    source = { root, dbPath, api: 'v2' as const, storage: 'sqlite' as const }
  writeFileSync(dbPath, 'unreadable database')
  expect(await readOpenCodeSessionPresence(source, 'ses_missing')).toBe('unavailable')
  rmSync(dbPath)
  writeOpenCodeSqliteDatabase(dbPath, [{ id: 'ses_old', directory: '/work', turns: [] }])
  const db = new Database(dbPath)
  db.exec(
    'CREATE TABLE session_v2 (id TEXT, project_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)'
  )
  expect(await readOpenCodeSessionPresence(source, 'ses_old')).toBe('unavailable')
  db.exec('BEGIN EXCLUSIVE')
  expect(await readOpenCodeSessionPresence({ ...source, api: 'v1' }, 'ses_old')).toBe('unavailable')
  db.exec('ROLLBACK')
  db.close()
})
it('distinguishes an entirely deleted source from an unreachable symlink or import candidate', async () => {
  const missing = join(root, 'missing'),
    source = {
      root: missing,
      dbPath: join(missing, 'opencode.db'),
      api: 'v2' as const,
      storage: 'sqlite' as const
    }
  expect(await readOpenCodeSessionPresence(source, 'ses_old')).toBe('absent')
  symlinkSync(join(root, 'unreachable'), missing, 'junction')
  expect(await readOpenCodeSessionPresence(source, 'ses_old')).toBe('unavailable')
  writeFileSync(join(root, 'opencode-next.db'), 'unknown import')
  expect(
    await readOpenCodeSessionPresence(
      { ...source, root, dbPath: join(root, 'opencode.db') },
      'ses_old'
    )
  ).toBe('unavailable')
})

it('reads only the selected legacy project, with population-independent work at N and 10N', async () => {
  const cwd = join(root, 'repo')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  writeFileSync(join(cwd, '.git/opencode'), 'selected')
  const source = { root, cwd, env: {}, api: 'v1' as const, storage: 'legacy' as const }
  const put = (project: string) => {
    const dir = join(root, 'storage/session', project)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ses_kept.json'), legacyRow(project, cwd))
  }
  mkdirSync(join(root, 'storage/project'), { recursive: true })
  writeFileSync(join(root, 'storage/project/selected.json'), '{}')
  const read = vi.mocked(fs.readFile),
    stat = vi.mocked(fs.stat)
  try {
    const counts: number[] = []
    for (const n of [20, 200]) {
      for (let i = 0; i < n; i++) {
        put(`other-${i}`)
      }
      read.mockClear()
      stat.mockClear()
      for (let p = 0; p < 3; p++) {
        expect(await readOpenCodeSessionPresence(source, 'ses_kept')).toBe('absent')
      }
      counts.push(read.mock.calls.length + stat.mock.calls.length)
      expect(read.mock.calls.every(([path]) => String(path).endsWith('.git/opencode'))).toBe(true)
    }
    expect(counts[1]).toBe(counts[0])
    put('selected')
    read.mockClear()
    stat.mockClear()
    for (let p = 0; p < 30; p++) {
      expect(await readOpenCodeSessionPresence(source, 'ses_kept')).toBe('present')
    }
    expect(read).toHaveBeenCalledTimes(60)
    expect(stat).toHaveBeenCalledTimes(60)
    rmSync(join(root, 'storage/session/selected/ses_kept.json'))
    rmSync(join(root, 'storage/project/selected.json'))
    put('global')
    expect(await readOpenCodeSessionPresence(source, 'ses_kept')).toBe('unavailable')
  } finally {
    vi.restoreAllMocks()
  }
})
it('derives the legacy root project with the launch env without writing its cache', async () => {
  const cwd = join(root, 'repo'),
    env = { HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: '1', PATH: '/usr/bin:/bin' }
  mkdirSync(cwd)
  const git = (command: string) =>
    runProcess({ program: 'git', args: command.split(' '), cwd, env, timeoutMs: 1000 })
  expect((await git('init')).code).toBe(0)
  const commit = await git(
    '-c user.name=Fixture -c user.email=fixture@example.test commit --allow-empty -m fixture'
  )
  expect(commit.code).toBe(0)
  const id = (await git('rev-list --max-parents=0 --all')).stdout.trim()
  const dir = join(root, 'storage/session', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ses_kept.json'), legacyRow(id, cwd))
  expect(
    await readOpenCodeSessionPresence({ root, cwd, env, api: 'v1', storage: 'legacy' }, 'ses_kept')
  ).toBe('present')
  await expect(fs.stat(join(cwd, '.git/opencode'))).rejects.toMatchObject({ code: 'ENOENT' })
})
