import { readFile, stat, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { asRecord } from '../ai-vault/session-scanner-record-value'
import { openOpenCodeDatabaseReadonly } from '../ai-vault/session-scanner-opencode-sqlite-open'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

export type OpenCodeSessionPresence = 'present' | 'absent' | 'unavailable'
export type OpenCodeSessionSource =
  | { root: string; dbPath: string; api: 'v1' | 'v2'; storage: 'sqlite' }
  | { root: string; cwd: string; env: NodeJS.ProcessEnv; api: 'v1'; storage: 'legacy' }

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (asRecord(error)?.code === 'ENOENT') {
      // A dangling link is an unavailable source, not confirmed deletion.
      try {
        await lstat(path)
        throw new Error('Unreachable source')
      } catch (missing) {
        if (asRecord(missing)?.code !== 'ENOENT') {
          throw missing
        }
      }
      const parent = dirname(path)
      if (parent !== path) {
        await exists(parent)
      }
      return false
    }
    throw error
  }
}

async function legacyProject(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  for (let directory = cwd; ; directory = dirname(directory)) {
    const git = join(directory, '.git')
    if (await exists(git)) {
      let cached = ''
      try {
        cached = (await readFile(join(git, 'opencode'), 'utf8')).trim()
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(String(asRecord(error)?.code))) {
          throw error
        }
      }
      if (cached) {
        return cached
      }
      const roots = await runProcess({
        program: 'git',
        env,
        args: ['rev-list', '--max-parents=0', '--all'],
        cwd: directory,
        timeoutMs: 500,
        maxOutputBytes: 65536
      })
      if (roots.timedOut || roots.outputTruncated || roots.code === null) {
        throw new Error('Unknown project')
      }
      return (
        roots.stdout
          .split('\n')
          .map((id) => id.trim())
          .filter(Boolean)
          .sort()[0] || 'global'
      )
    }
    if (directory === dirname(directory)) {
      return 'global'
    }
  }
}

async function legacyPresence(
  source: Extract<OpenCodeSessionSource, { storage: 'legacy' }>,
  id: string
) {
  const project = await legacyProject(source.cwd, source.env)
  if (!/^[A-Za-z0-9_-]+$/.test(project)) {
    return 'unavailable'
  }
  const path = join(source.root, 'storage', 'session', project, `${id}.json`)
  if (!(await exists(path))) {
    // A new project may import global sessions; inspection must never perform that migration.
    return project !== 'global' &&
      !(await exists(join(source.root, 'storage', 'project', `${project}.json`))) &&
      (await exists(join(source.root, 'storage', 'session', 'global', `${id}.json`)))
      ? 'unavailable'
      : 'absent'
  }
  const row = asRecord(JSON.parse(await readFile(path, 'utf8')))
  const time = asRecord(row?.time)
  return row?.id === id &&
    row.projectID === project &&
    typeof row.directory === 'string' &&
    typeof row.version === 'string' &&
    Number.isFinite(time?.created) &&
    Number.isFinite(time?.updated)
    ? 'present'
    : 'unavailable'
}

/** Worker-only exact metadata read; old imported rows never override current provider truth. */
export async function readOpenCodeSessionPresence(
  source: OpenCodeSessionSource,
  sessionId: string
): Promise<OpenCodeSessionPresence> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    return 'unavailable'
  }
  try {
    if (source.storage === 'legacy') {
      return await legacyPresence(source, sessionId)
    }
    const { root, dbPath, api } = source
    if (await exists(dbPath)) {
      const db = openOpenCodeDatabaseReadonly(dbPath, 0)
      try {
        const table = api === 'v2' ? 'session_v2' : 'session'
        if (
          !tableExists(db, table) ||
          !['id', 'project_id', 'directory', 'time_created', 'time_updated'].every((key) =>
            columnExists(db, table, key)
          )
        ) {
          return 'unavailable'
        }
        if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(sessionId)) {
          return 'present'
        }
        if (api === 'v2' && tableExists(db, 'session')) {
          const state = tableExists(db, 'kv')
            ? asRecord(db.prepare('SELECT value FROM kv WHERE key = ?').get('migration.v1-v2'))
            : undefined
          if (
            typeof state?.value !== 'string' ||
            asRecord(JSON.parse(state.value))?.phase !== 'completed'
          ) {
            return 'unavailable'
          }
        }
        return 'absent'
      } finally {
        db.close()
      }
    }
    // A new v2 database may import this exact predecessor, never arbitrary channel archives.
    if (api === 'v2' && (await exists(join(root, 'opencode-next.db')))) {
      return 'unavailable'
    }
    // SQLite initialization can import legacy JSON; do not infer absence before that migration.
    return (await exists(join(root, 'storage', 'session'))) ? 'unavailable' : 'absent'
  } catch {
    return 'unavailable'
  }
}
