import { DatabaseSync } from 'node:sqlite'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_STORE_DIRECTORIES,
  codexConversationStore,
  discoverCodexStoreHomes,
  reconcileCodexOverlaySignOut,
  resolveCodexLaunchHome
} from './codex-launch-home'
import { resolveEffectiveCodexSqliteHome } from './codex-sqlite-home'
import { safeRemoveTree } from '../pty/overlay-mirror'

vi.mock('./codex-home-paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncSystemCodexResourcesIntoManagedHome: vi.fn()
}))

let root: string
let system: string
let accounts: string
let a: string
let b: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-store-overlay-'))
  system = join(root, 'system')
  accounts = join(root, 'codex-accounts')
  a = account('a')
  b = account('b')
  mkdirSync(system)
  writeFileSync(join(system, 'config.toml'), 'model = "test"\n')
})
afterEach(() => {
  safeRemoveTree(root)
})

function account(id: string): string {
  const home = join(accounts, id, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.orca-managed-home'), id)
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ account: id }))
  writeFileSync(join(home, 'config.toml'), '# legacy settings stay here\n')
  return home
}
function launch(login: string | null, conversationHome?: string, readOnly = false): string {
  const home = resolveCodexLaunchHome({
    selectedAccount: login ? { homePath: login } : null,
    conversationHome,
    systemHome: system,
    accountsRoot: accounts,
    readOnly
  })
  return home ?? system
}

describe('Codex login overlays over conversation stores', () => {
  it('atomically links the store directories, leaving login and indexes private', () => {
    const predicted = launch(a, undefined, true)
    expect(existsSync(predicted)).toBe(false)
    const overlay = launch(a)
    expect(overlay).toBe(predicted)
    for (const entry of CODEX_STORE_DIRECTORIES) {
      expect(realpathSync(join(overlay, entry))).toBe(realpathSync(join(system, entry)))
    }
    expect(readFileSync(join(overlay, 'auth.json'), 'utf8')).toContain('a')
    expect(resolveEffectiveCodexSqliteHome(overlay)).toBe(realpathSync(system))
    expect(readFileSync(join(overlay, 'config.toml'), 'utf8')).toContain(
      'cli_auth_credentials_store = "file"'
    )
    for (const entry of ['tmp', 'log', 'memories']) {
      mkdirSync(join(overlay, entry))
      expect(lstatSync(join(overlay, entry)).isSymbolicLink()).toBe(false)
      expect(existsSync(join(system, entry))).toBe(false)
    }
    writeFileSync(join(overlay, 'session_index.jsonl'), 'private index\n')
    writeFileSync(join(overlay, 'models_cache.json'), '{}')
    expect(existsSync(join(system, 'session_index.jsonl'))).toBe(false)
    expect(launch(a)).toBe(overlay)
    expect(readFileSync(join(a, 'config.toml'), 'utf8')).toBe('# legacy settings stay here\n')
  })

  it('A → B → A reads one current rollout after undo, including across a legacy store', () => {
    const sqlite = join(root, 'database')
    mkdirSync(sqlite)
    writeFileSync(join(system, 'config.toml'), `sqlite_home = ${JSON.stringify(sqlite)}\n`)
    const first = launch(a)
    const second = launch(b, first)
    const db = new DatabaseSync(join(resolveEffectiveCodexSqliteHome(first), 'state_5.sqlite'))
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT); INSERT INTO threads VALUES ('T', 'before-undo')"
    )
    const switched = new DatabaseSync(
      join(resolveEffectiveCodexSqliteHome(second), 'state_5.sqlite')
    )
    switched.exec("UPDATE threads SET rollout_path = 'after-undo' WHERE id = 'T'")
    switched.close()
    const resumed = launch(a, second)
    expect(resumed).toBe(first)
    expect(resolveEffectiveCodexSqliteHome(resumed)).toBe(resolveEffectiveCodexSqliteHome(second))
    expect(db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get('T')).toEqual({
      rollout_path: 'after-undo'
    })
    db.close()

    mkdirSync(join(a, 'sessions'), { recursive: true })
    writeFileSync(join(a, 'sessions', 'old.jsonl'), 'legacy conversation')
    expect(launch(a, a)).toBe(a)
    const oldUnderB = launch(b, a)
    expect(codexConversationStore(oldUnderB)).toBe(realpathSync(a))
    expect(readFileSync(join(oldUnderB, 'sessions', 'old.jsonl'), 'utf8')).toBe(
      'legacy conversation'
    )
    expect(resolveEffectiveCodexSqliteHome(oldUnderB)).toBe(realpathSync(a))
    expect(readFileSync(join(a, 'config.toml'), 'utf8')).toBe('# legacy settings stay here\n')
    expect(existsSync(join(system, 'sessions', 'old.jsonl'))).toBe(false)
    expect(discoverCodexStoreHomes(accounts)).toEqual(
      expect.arrayContaining([a, b, oldUnderB, realpathSync(system)])
    )
  })

  it('keys overlays by canonical store and never retargets a previous overlay', () => {
    const old = launch(a)
    const nextStore = join(root, 'next-store')
    mkdirSync(nextStore)
    const next = launch(a, nextStore)
    expect(next).not.toBe(old)
    expect(codexConversationStore(old)).toBe(realpathSync(system))
    expect(codexConversationStore(next)).toBe(realpathSync(nextStore))
  })

  it('propagates logout but preserves an atomic re-auth newer than the missing link', () => {
    const overlay = launch(a)
    unlinkSync(join(overlay, 'auth.json'))
    reconcileCodexOverlaySignOut(dirname(a), a)
    expect(existsSync(join(a, 'auth.json'))).toBe(false)

    writeFileSync(join(a, 'auth.json'), '{"account":"new login"}')
    launch(a)
    unlinkSync(join(overlay, 'auth.json'))
    writeFileSync(join(a, 'reauth.json'), '{"account":"reauthenticated"}')
    renameSync(join(a, 'reauth.json'), join(a, 'auth.json'))
    launch(a)
    expect(readFileSync(join(overlay, 'auth.json'), 'utf8')).toContain('reauthenticated')
  })

  it('keeps system-default unset and refuses a keyring-only login for another store', () => {
    expect(resolveCodexLaunchHome({ selectedAccount: null, systemHome: system })).toBeUndefined()
    expect(() => launch(null, a)).toThrow(
      'Codex cannot use this conversation with a keyring-only login'
    )
    writeFileSync(join(system, 'auth.json'), '{"system":true}')
    const overlay = launch(null, a)
    expect(codexConversationStore(overlay)).toBe(realpathSync(a))
    expect(readFileSync(join(overlay, 'auth.json'), 'utf8')).toContain('system')
  })
})
