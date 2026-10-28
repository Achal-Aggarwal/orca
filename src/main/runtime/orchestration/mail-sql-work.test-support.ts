import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import { expect, vi } from 'vitest'
import type SyncDatabase from '../../sqlite/sync-database'

/** Count indexed candidates; retain every binding and bytecode, rather than inferring visits from SEARCH. */
export function observeMailSqlWork(
  database: SyncDatabase,
  matches: (sql: string) => boolean,
  expression: string,
  predicate = false
) {
  const native = z
    .instanceof(DatabaseSync)
    .parse(Object.getOwnPropertyDescriptor(database, 'db')?.value)
  let evaluations = 0
  let observing = true
  const statements: {
    original: string
    instrumented: string
    args: SQLInputValue[]
    rows: number
    bytes: number
    method: 'all' | 'get'
  }[] = []
  const seen = new WeakSet()
  native.function('observe_mail_work', { deterministic: true }, (value) => {
    if (observing) {
      evaluations++
    }
    return value
  })
  const prepare = database.prepare.bind(database)
  const spy = vi.spyOn(database, 'prepare').mockImplementation((sql) => {
    if (!matches(sql)) {
      return prepare(sql)
    }
    expect(sql).toContain(expression)
    const instrumented = predicate
      ? sql.replace('ORDER BY', `AND observe_mail_work(${expression}) IS NOT NULL ORDER BY`)
      : sql.replace(expression, `observe_mail_work(${expression}) AS ${expression}`)
    const statement = prepare(instrumented)
    if (!seen.has(statement)) {
      seen.add(statement)
      const record = <T>(method: 'all' | 'get', args: SQLInputValue[], result: T): T => {
        statements.push({
          original: sql,
          instrumented,
          args,
          method,
          rows: Array.isArray(result) ? result.length : result ? 1 : 0,
          bytes: result ? Buffer.byteLength(JSON.stringify(result)) : 0
        })
        return result
      }
      const all = statement.all.bind(statement)
      const get = statement.get.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => record('all', args, all(...args)))
      vi.spyOn(statement, 'get').mockImplementation((...args) => record('get', args, get(...args)))
    }
    return statement
  })
  return {
    count: () => evaluations,
    calls: statements,
    reset: () => {
      evaluations = 0
      statements.length = 0
    },
    verify: () => {
      expect(statements.length).toBeGreaterThan(0)
      observing = false
      try {
        return statements.map(({ original, instrumented, args, method }) => {
          expect(native.prepare(`EXPLAIN QUERY PLAN ${instrumented}`).all(...args)).toEqual(
            native.prepare(`EXPLAIN QUERY PLAN ${original}`).all(...args)
          )
          expect(native.prepare(instrumented)[method](...args)).toEqual(
            native.prepare(original)[method](...args)
          )
          const bytecode = native.prepare(`EXPLAIN ${original}`).all(...args)
          if (predicate) {
            const opcodes = bytecode.map((row) => row.opcode)
            expect(opcodes).toContain('SeekGT')
            expect(opcodes).toContain('IdxGT')
            expect(opcodes.filter((op) => op === 'Next')).toHaveLength(1)
            expect(opcodes).not.toContain('Rewind')
            expect(opcodes).not.toContain('SorterOpen')
          }
          return { args, bytecode }
        })
      } finally {
        observing = true
      }
    },
    restore: () => spy.mockRestore()
  }
}
