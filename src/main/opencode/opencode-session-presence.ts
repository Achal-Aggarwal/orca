import { readFile, readdir, stat, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { asRecord } from '../ai-vault/session-scanner-record-value'
import { openOpenCodeDatabaseReadonly } from '../ai-vault/session-scanner-opencode-sqlite-open'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

export type OpenCodeSessionPresence = 'present' | 'absent' | 'unavailable'
export type OpenCodeSessionSource = { root: string; dbPath: string; api: 'v1' | 'v2' }

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

/** Worker-only exact metadata read; old imported rows never override current provider truth. */
export async function readOpenCodeSessionPresence(
  source: OpenCodeSessionSource,
  sessionId: string
): Promise<OpenCodeSessionPresence> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    return 'unavailable'
  }
  const { root, dbPath, api } = source
  try {
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
    const sessions = join(root, 'storage', 'session')
    if (!(await exists(sessions))) {
      return 'absent'
    }
    let uncertain = false
    for (const project of await readdir(sessions, { withFileTypes: true })) {
      if (!project.isDirectory()) {
        uncertain = true
        continue
      }
      const path = join(sessions, project.name, `${sessionId}.json`)
      if (!(await exists(path))) {
        continue
      }
      const row = asRecord(JSON.parse(await readFile(path, 'utf8')))
      const time = asRecord(row?.time)
      if (
        row?.id === sessionId &&
        row.projectID === project.name &&
        typeof row.directory === 'string' &&
        typeof row.version === 'string' &&
        Number.isFinite(time?.created) &&
        Number.isFinite(time?.updated)
      ) {
        return 'present'
      }
      uncertain = true
    }
    return uncertain ? 'unavailable' : 'absent'
  } catch {
    return 'unavailable'
  }
}
