import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import Database from '../sqlite/sync-database'
import { writeOpenCodeSqliteDatabase } from '../ai-vault/session-scanner-opencode-sqlite-fixture'
import { readOpenCodeSessionPresence } from './opencode-session-presence'
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sta-11913-store-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
it.each(['legacy', 'v1', 'v2'] as const)(
  '%s exact metadata includes an empty session and distinguishes deletion',
  async (kind) => {
    const dbPath = join(root, 'custom.db')
    const source = { root, dbPath, api: kind === 'v2' ? ('v2' as const) : ('v1' as const) }
    if (kind === 'legacy') {
      const dir = join(root, 'storage', 'session', 'project')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'ses_kept.json'),
        JSON.stringify({
          id: 'ses_kept',
          projectID: 'project',
          directory: '/work',
          version: '1.1.1',
          time: { created: 1, updated: 2 }
        })
      )
    } else {
      writeOpenCodeSqliteDatabase(dbPath, [{ id: 'ses_kept', directory: '/work', turns: [] }])
      if (kind === 'v2') {
        const db = new Database(dbPath)
        // Recorded v2 metadata columns; no message or transcript is needed to establish presence.
        db.exec(
          'CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL); CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);'
        )
        db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)').run(
          'ses_kept',
          'project',
          '/work',
          1,
          2
        )
        db.prepare('INSERT INTO kv VALUES (?, ?)').run(
          'migration.v1-v2',
          JSON.stringify({ phase: 'completed' })
        )
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
    source = { root, dbPath, api: 'v2' as const }
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
    source = { root: missing, dbPath: join(missing, 'opencode.db'), api: 'v2' as const }
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
