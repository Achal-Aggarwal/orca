import { buildAgentResumeStartupPlan } from '../../../../shared/tui-agent-resume-startup'
import { prepareSavedPtyResume } from '../spawn-resume'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { writeOpenCodeSqliteDatabase } from '../../../ai-vault/session-scanner-opencode-sqlite-fixture'
import { handleOpenCodeSqliteRequest } from '../../../ai-vault/session-scanner-opencode-sqlite-dispatch'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session-record-store'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import {
  admitColdRestoreReattach,
  chooseSavedResumeFreshLaunch,
  forgetRefusedResume,
  resumeSpawnRefusal
} from './saved-resume-admission'

const account = vi.hoisted(() => ({ dataHome: '', removed: false }))
const forget = vi.hoisted(() => vi.fn())
const readPresence = vi.hoisted(() => vi.fn())
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { forgetRefusedPaneResume: forget }
}))
vi.mock('../../../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({
    environmentForAccount: (_provider: string, id: string) => {
      if (account.removed || id !== 'original-account') {
        throw new Error('Removed')
      }
      return {
        XDG_DATA_HOME: account.dataHome,
        XDG_STATE_HOME: join(account.dataHome, 'state'),
        OPENCODE_DB: 'opencode.db',
        OPENCODE_AUTH_CONTENT: ''
      }
    }
  })
}))
vi.mock('../../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', () => ({
  getSharedClient: () => ({ readSessionPresence: readPresence })
}))
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only these two store methods.
const records = {
  listConversations: () => [],
  getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] })
} as unknown as AgentSessionRecordStore
const runtime = {
  openAgentSessionRecordStore: async () => records,
  getAgentProviderSessionRows: () => []
}
let root: string
let temp: string
let source: SleepingAgentSessionRecord
beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'sta-11913-')))
  account.dataHome = join(temp, 'owning-host-account')
  root = join(account.dataHome, 'opencode')
  mkdirSync(root, { recursive: true })
  account.removed = false
  source = {
    paneKey: 'pane',
    worktreeId: 'wt',
    agent: 'opencode',
    providerSession: { key: 'session_id', id: 'ses_kept' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    launchConfig: {
      agentCommand: 'opencode',
      agentArgs: '',
      agentEnv: { ORCA_DATA_ACCOUNT_ID: 'original-account' }
    }
  }
  readPresence.mockImplementation(async (args) => {
    const reply = await handleOpenCodeSqliteRequest({ ...args, id: 1, kind: 'session-presence' })
    if (!reply.ok) {
      throw new Error(reply.error)
    }
    if (reply.value === 'present' || reply.value === 'absent' || reply.value === 'unavailable') {
      return reply.value
    }
    throw new Error('Invalid reply')
  })
})
afterEach(() => {
  rmSync(temp, { recursive: true, force: true })
  vi.clearAllMocks()
})
function args() {
  return {
    worktreeId: 'wt',
    resumeOrigin: 'saved',
    launchAgent: source.agent,
    resumeProviderSession: source.providerSession,
    launchConfig: source.launchConfig,
    command: buildAgentResumeStartupPlan({
      agent: source.agent,
      providerSession: source.providerSession,
      cmdOverrides: {},
      platform: process.platform
    })?.launchCommand,
    env: { ...source.launchConfig?.agentEnv },
    startupIngress: 'saved',
    startupCommandDelivery: 'shell-ready'
  }
}
async function fresh() {
  const request = args()
  const options = args()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prepareSavedPtyResume consumes only this captured-source and fresh-selection context.
  const ctx = {
    args: request,
    spawnOptions: options,
    expectedWslDistro: null,
    deps: { runtime: { ...runtime, readSavedResumeSource: async () => source }, store: undefined }
  } as unknown as Parameters<typeof prepareSavedPtyResume>[0]
  const choose = await prepareSavedPtyResume(ctx, {
    sessionId: undefined,
    paneKey: 'pane',
    savedResumePaneKey: 'pane',
    launchConfig: source.launchConfig
  })
  await choose()
  return { decision: ctx.resumeAdmission, request, options }
}
async function cold(context = args()) {
  return admitColdRestoreReattach(
    runtime,
    { coldRestore: {} },
    { paneKey: 'pane', saved: source },
    null,
    context
  )
}
it.each(['legacy', 'v1', 'v2'] as const)(
  '%s empty metadata is present; deletion suppresses both callers without clearing saved data',
  async (kind) => {
    if (kind === 'v2' && source.launchConfig) {
      source.agent = 'opencode2'
      source.launchConfig.agentCommand = 'opencode2 --standalone'
    }
    const path = join(root, kind === 'v2' ? 'opencode-next.db' : 'opencode.db')
    const legacy = join(root, 'storage', 'session', 'project', 'ses_kept.json')
    if (kind === 'legacy') {
      mkdirSync(join(root, 'storage', 'session', 'project'), { recursive: true })
      writeFileSync(
        legacy,
        JSON.stringify({
          id: 'ses_kept',
          projectID: 'project',
          directory: '/repo',
          title: 'Empty',
          version: '1.1.1',
          time: { created: 1740000000000, updated: 1740000000000 }
        })
      )
    } else if (kind === 'v1') {
      writeOpenCodeSqliteDatabase(path, [{ id: 'ses_kept', turns: [] }])
    } else {
      const db = new Database(path)
      db.exec(`CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
      fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
      path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT,
      cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_compacting INTEGER, time_archived INTEGER);
      INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated)
      VALUES ('ses_kept', 'project', 'empty', '/repo', '2.0.21', 1740000000000, 1740000000000);`)
      db.close()
    }
    expect((await fresh()).decision?.verdict).toBe('admitted')
    expect(await readPresence.mock.results.at(-1)?.value).toBe('present')
    if (kind === 'legacy') {
      rmSync(legacy)
    } else {
      const db = new Database(path)
      db.exec(`DELETE FROM ${kind === 'v1' ? 'session' : 'session_v2'}`)
      db.close()
    }
    const before = structuredClone(source)
    const result = await fresh()
    expect(result.decision?.verdict).toBe('unverifiable')
    expect([
      result.request.command,
      result.options.command,
      result.options.startupIngress,
      result.options.startupCommandDelivery
    ]).toEqual([undefined, undefined, undefined, undefined])
    expect((await cold())?.verdict).toBe('unverifiable')
    expect((await cold({ ...args(), env: {} }))?.verdict).toBe('admitted')
    forgetRefusedResume('pane', resumeSpawnRefusal(result.decision))
    expect(forget).not.toHaveBeenCalled()
    expect(source).toEqual(before)
    expect(readPresence).toHaveBeenCalledWith(
      { root, sessionId: 'ses_kept' },
      expect.any(AbortSignal)
    )
  }
)
it('unknown, unreadable, malformed and contended sources never prove deletion; coexisting presence wins', async () => {
  expect((await fresh()).decision?.verdict).toBe('admitted')
  writeOpenCodeSqliteDatabase(join(root, 'opencode.db'), [])
  writeFileSync(join(root, 'opencode-next.db'), 'unreadable SQLite')
  expect((await fresh()).decision?.verdict).toBe('admitted')
  writeOpenCodeSqliteDatabase(join(root, 'opencode.db'), [{ id: 'ses_kept', turns: [] }])
  expect((await fresh()).decision?.verdict).toBe('admitted')
  rmSync(join(root, 'opencode-next.db'))
  const db = new Database(join(root, 'opencode.db'))
  try {
    db.exec('DELETE FROM session; CREATE TABLE session_v2 (id TEXT);')
    expect((await fresh()).decision?.verdict).toBe('admitted')
    db.exec('DROP TABLE session_v2; BEGIN EXCLUSIVE;')
    expect((await fresh()).decision?.verdict).toBe('admitted')
  } finally {
    db.close()
  }
  mkdirSync(join(root, 'storage', 'session', 'project'), { recursive: true })
  writeFileSync(join(root, 'storage', 'session', 'project', 'ses_kept.json'), '{bad')
  expect((await fresh()).decision?.verdict).toBe('admitted')
})
it('unknown provenance, a removed owner, conflicting env, explicit and WSL starts retain current behavior', async () => {
  writeOpenCodeSqliteDatabase(join(root, 'opencode.db'), [])
  for (const request of [
    { ...args(), envToDelete: ['OPENCODE_DB'] },
    { ...args(), env: { ORCA_DATA_ACCOUNT_ID: 'other-account' } },
    { ...args(), launchConfig: undefined }
  ]) {
    expect(
      (await chooseSavedResumeFreshLaunch(runtime, request, null, request, source))?.verdict
    ).toBe('admitted')
  }
  account.removed = true
  expect((await fresh()).decision?.verdict).toBe('admitted')
  account.removed = false
  expect(
    await chooseSavedResumeFreshLaunch(
      runtime,
      { ...args(), resumeOrigin: undefined },
      null,
      args(),
      source
    )
  ).toBeNull()
  expect(await chooseSavedResumeFreshLaunch(runtime, args(), 'Ubuntu', args(), source)).toBeNull()
  source.providerSession = { key: 'session_id', id: '../unsafe' }
  expect((await fresh()).decision?.verdict).toBe('admitted')
})
it('the whole-decision deadline includes a stalled worker request', async () => {
  readPresence.mockImplementationOnce(() => new Promise(() => {}))
  const start = Date.now()
  expect((await fresh()).decision?.verdict).toBe('admitted')
  expect(Date.now() - start).toBeLessThan(2000)
})
