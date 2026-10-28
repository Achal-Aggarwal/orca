import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveOpenCodeSessionSource } from './opencode-session-source'
let root: string
const get = vi.fn()
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sta-11913-source-'))
  vi.stubGlobal('fetch', get)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
function file(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}
function args() {
  return {
    env: {
      HOME: root,
      USERPROFILE: root,
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'config')
    },
    cwd: root,
    version: '2.0.16',
    api: 'v2' as const,
    standalone: false,
    sessionId: 'ses_deleted',
    signal: AbortSignal.timeout(1000)
  }
}
const registration = () => ({
  id: 'test',
  pid: process.pid,
  version: '2.0.16',
  url: 'http://127.0.0.1:12345',
  password: 'fixture-only'
})
it.each([
  [200, { data: { id: 'ses_deleted' } }, 'present'],
  [404, { _tag: 'SessionNotFoundError', sessionID: 'ses_deleted', message: 'missing' }, 'absent'],
  [404, { message: 'route not found' }, 'unavailable'],
  [404, { _tag: 'SessionNotFoundError', sessionID: 'different' }, 'unavailable'],
  [401, { message: 'unauthorized' }, 'unavailable'],
  [200, { data: {} }, 'unavailable']
])('uses only the validated service’s exact response (%s)', async (status, body, expected) => {
  file(join(root, 'state/opencode/service.json'), registration())
  get
    .mockResolvedValueOnce(Response.json({ pid: process.pid, version: '2.0.16' }))
    .mockResolvedValueOnce(Response.json(body, { status: Number(status) }))
  expect(await resolveOpenCodeSessionSource(args())).toBe(expected)
  expect(get).toHaveBeenNthCalledWith(
    2,
    new URL('http://127.0.0.1:12345/api/session/ses_deleted'),
    expect.objectContaining({
      redirect: 'error',
      headers: { authorization: `Basic ${Buffer.from('opencode:fixture-only').toString('base64')}` }
    })
  )
})
it('does not read CLI disk after an incompatible or unreachable service', async () => {
  file(join(root, 'state/opencode/service.json'), { ...registration(), version: '2.0.12' })
  expect(await resolveOpenCodeSessionSource(args())).toBe('unavailable')
  expect(get).not.toHaveBeenCalled()
  file(join(root, 'state/opencode/service.json'), registration())
  get.mockResolvedValueOnce(Response.json({ pid: process.pid + 1, version: '2.0.16' }))
  expect(await resolveOpenCodeSessionSource(args())).toBe('unavailable')
})
it.each([
  ['2.0.16', 'first.db'],
  ['2.0.31', 'second.db'],
  ['2.1.3', 'second.db']
])('projects source-backed service env order for %s', async (version, db) => {
  file(join(root, 'config/opencode/service.json'), {
    env: {
      XDG_DATA_HOME: join(root, 'child'),
      OPENCODE_CONFIG_DIR: join(root, 'redirected'),
      XDG_STATE_HOME: join(root, 'child-state'),
      OPENCODE_DB: 'first.db'
    }
  })
  file(join(root, 'redirected/service.json'), {
    env: {
      OPENCODE_DB: 'second.db',
      XDG_DATA_HOME: '/too-late'
    }
  })
  expect(await resolveOpenCodeSessionSource({ ...args(), version })).toEqual({
    root: join(root, 'child/opencode'),
    dbPath: join(root, 'child/opencode', db),
    api: 'v2',
    storage: 'sqlite'
  })
  expect(get).not.toHaveBeenCalled()
})
it.each([
  ['1.1.1', 'v1', 'ignored.db', 'legacy'],
  ['1.2.0', 'v1', 'ignored.db', 'opencode.db'],
  ['1.2.27', 'v1', 'ignored.db', 'opencode.db'],
  ['1.2.28', 'v1', 'uncertain.db', 'unavailable'],
  ['1.3.0', 'v1', 'custom.db', 'custom.db'],
  ['1.3.0', 'v1', '', 'opencode.db'],
  ['2.0.16', 'v2', '', 'unavailable'],
  ['2.0.16', 'v2', ':memory:', 'unavailable'],
  ['2.0.16', 'v2', '   ', '   '],
  ['2.0.16-beta', 'v2', 'opencode.db', 'unavailable'],
  ['3.0.0', 'v2', 'opencode.db', 'unavailable']
] as const)(
  'selects the %s storage dialect with DB %j',
  async (version, api, selection, expected) => {
    const input = {
      ...args(),
      version,
      api,
      standalone: true,
      env: { ...args().env, OPENCODE_DB: selection }
    }
    const result = await resolveOpenCodeSessionSource(input)
    expect(result).toEqual(
      expected === 'unavailable'
        ? expected
        : expected === 'legacy'
          ? { root: join(root, 'data/opencode'), cwd: root, env: input.env, api, storage: 'legacy' }
          : {
              root: join(root, 'data/opencode'),
              dbPath: join(root, 'data/opencode', expected),
              api,
              storage: 'sqlite'
            }
    )
  }
)
it('keeps unpinned or malformed source-affecting configuration unknown', async () => {
  expect(await resolveOpenCodeSessionSource({ ...args(), version: '2.2.0' })).toMatchObject({
    storage: 'sqlite'
  })
  file(join(root, 'config/opencode/service.json'), { env: { XDG_STATE_HOME: '/uncertain' } })
  await expect(resolveOpenCodeSessionSource({ ...args(), version: '2.2.0' })).rejects.toThrow(
    'Unknown service environment dialect'
  )
  file(join(root, 'config/opencode/service.json'), { disabled: 'true' })
  await expect(resolveOpenCodeSessionSource(args())).rejects.toThrow(
    'Unknown service configuration'
  )
  expect(get).not.toHaveBeenCalled()
})
