import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { asRecord } from '../ai-vault/session-scanner-record-value'
import { openOpenCodeDatabaseReadonly } from '../ai-vault/session-scanner-opencode-sqlite-open'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

export type OpenCodeSessionPresence = 'present' | 'absent' | 'unavailable'

/** Worker-only: the caller's whole-decision deadline also bounds discovery. */
export async function readOpenCodeSessionPresence(
  root: string,
  sessionId: string
): Promise<OpenCodeSessionPresence> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    return 'unavailable'
  }
  let recognized = false
  let uncertain = false
  const directory = async (path: string) => {
    if (!(await lstat(path)).isDirectory()) {
      throw new Error('Ambiguous session directory')
    }
    return readdir(path, { withFileTypes: true })
  }
  try {
    if ((await realpath(root)) !== resolve(root)) {
      return 'unavailable'
    }
    const entries = await directory(root)
    for (const entry of entries.filter((entry) =>
      /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/.test(entry.name)
    )) {
      if (!entry.isFile()) {
        uncertain = true
        continue
      }
      try {
        const db = openOpenCodeDatabaseReadonly(join(root, entry.name), 0)
        try {
          let tables = 0
          for (const table of ['session', 'session_v2']) {
            if (!tableExists(db, table)) {
              continue
            }
            if (
              !['id', 'project_id', 'directory', 'time_created', 'time_updated'].every((column) =>
                columnExists(db, table, column)
              )
            ) {
              uncertain = true
              continue
            }
            tables++
            if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(sessionId)) {
              return 'present'
            }
          }
          recognized ||= tables > 0
          uncertain ||= tables === 0
        } finally {
          db.close()
        }
      } catch {
        uncertain = true
      }
    }
    try {
      const storage = join(root, 'storage')
      const storageEntries = await directory(storage)
      if (storageEntries.some((entry) => entry.name === 'session')) {
        const sessions = join(storage, 'session')
        for (const project of await directory(sessions)) {
          if (!project.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(project.name)) {
            throw new Error('Ambiguous project')
          }
          const path = join(sessions, project.name, `${sessionId}.json`)
          try {
            if (!(await lstat(path)).isFile()) {
              throw new Error('Ambiguous session file')
            }
            const row = asRecord(JSON.parse(await readFile(path, 'utf8')))
            const time = asRecord(row?.time)
            if (
              row?.id !== sessionId ||
              row.projectID !== project.name ||
              typeof row.directory !== 'string' ||
              typeof row.title !== 'string' ||
              typeof row.version !== 'string' ||
              !Number.isFinite(time?.created) ||
              !Number.isFinite(time?.updated)
            ) {
              throw new Error('Unknown session metadata')
            }
            return 'present'
          } catch (error) {
            if (asRecord(error)?.code !== 'ENOENT') {
              uncertain = true
            }
          }
        }
        recognized = true
      }
    } catch (error) {
      if (asRecord(error)?.code !== 'ENOENT') {
        uncertain = true
      }
    }
  } catch {
    uncertain = true
  }
  return recognized && !uncertain ? 'absent' : 'unavailable'
}
