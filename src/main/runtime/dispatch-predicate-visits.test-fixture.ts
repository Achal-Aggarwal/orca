import { DatabaseSync } from 'node:sqlite'
import { vi } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'

// SQL predicate visits complement range plans/probe counts; they are not total SQLite VM steps.
export function installSqlVisitCounters(counters: Record<string, () => number>) {
  const initialized = new WeakSet<DatabaseSync>()
  const prepare = DatabaseSync.prototype.prepare
  return vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql
  ) {
    if (!initialized.has(this)) {
      for (const [name, visit] of Object.entries(counters)) {
        this.function(name, {}, (_rowid: unknown) => visit())
      }
      initialized.add(this)
    }
    return prepare.call(this, sql)
  })
}

export function traceDispatchPredicateVisits(
  db: SyncDatabase,
  functions: { candidate: string; latest?: string; observation?: string }
) {
  const prepare = db.prepare.bind(db)
  return vi.spyOn(db, 'prepare').mockImplementation((query) => {
    let instrumented = query.replaceAll(
      'WHERE assignee_orca_session_id IS NOT NULL',
      `WHERE assignee_orca_session_id IS NOT NULL AND ${functions.candidate}(rowid)`
    )
    if (functions.latest && query.includes('rowid AS n')) {
      instrumented = instrumented.replace(
        'ORDER BY rowid DESC LIMIT 1',
        `AND ${functions.latest}(rowid) ORDER BY rowid DESC LIMIT 1`
      )
    }
    if (functions.observation) {
      instrumented = instrumented.replace(
        'WHERE dispatch_id IN',
        `WHERE ${functions.observation}(rowid) AND dispatch_id IN`
      )
    }
    return prepare(instrumented)
  })
}
