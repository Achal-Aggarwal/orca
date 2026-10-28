import '../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { main } from './index'
import { RuntimeClient } from './runtime-client'
import * as mutations from '../main/linear/linear-issue-mutations'
import * as comments from '../main/linear/linear-issue-comments'
import * as relations from '../main/linear/issue-relation-write'
import { LinearWriteFailure } from '../main/linear/linear-issue-write-support'
import { OrcaRuntimeService } from '../main/runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../main/runtime/runtime-rpc'
import { LINEAR_AGENT_ACCESS_METHODS } from '../main/runtime/rpc/methods/linear-agent-access'

const writeId = '11111111-1111-4111-8111-111111111111'
const issue = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Title',
  description: '',
  url: 'https://linear.app/acme/issue/ENG-1',
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
  state: { id: 'todo', name: 'Todo' },
  parent: null,
  project: null,
  assignee: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  labelIds: [],
  labels: []
}
const target = { issue, workspaceId: 'w1' }
const comment = {
  id: writeId,
  url: null,
  body: 'old',
  issue,
  parentId: null,
  threadRootId: writeId
}
let runtime: OrcaRuntimeService
let server: OrcaRuntimeRpcServer
let userDataPath: string

beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'linear-write-cli-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userDataPath)
  for (const name of [
    'ORCA_PAIRING_CODE',
    'ORCA_REMOTE_PAIRING',
    'ORCA_ENVIRONMENT',
    'ORCA_WORKTREE_ID',
    'ORCA_TERMINAL_HANDLE',
    'ORCA_RUNTIME_SOURCE_ID'
  ]) {
    vi.stubEnv(name, '')
  }
  process.exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'resolveLinearAgentWriteTarget').mockImplementation(async (params) =>
    params.input === 'ENG-2'
      ? { ...target, issue: { ...issue, id: 'issue-2', identifier: 'ENG-2' } }
      : target
  )
  vi.spyOn(runtime, 'resolveLinearCreateTeam').mockResolvedValue({
    ...issue.team,
    workspaceId: 'w1'
  })
  vi.spyOn(runtime, 'getLinearTeamStatesForWrite').mockResolvedValue([
    { id: 'done', name: 'Done', type: 'completed', color: '#888888', position: 1 }
  ])
  vi.spyOn(runtime, 'readLinearAgentIssueWriteRecord').mockResolvedValue(issue)
  vi.spyOn(runtime, 'getLinearTeamLabelsForWrite').mockResolvedValue([
    { id: 'bug', name: 'Bug', color: '#888888' }
  ])
  vi.spyOn(runtime, 'resolveLinearAgentComment').mockResolvedValue({ comment, workspaceId: 'w1' })
  vi.spyOn(runtime, 'getMatchingLinearCommentWrite').mockResolvedValue(null)
  vi.spyOn(runtime, 'getMatchingLinearAttachmentWrite').mockResolvedValue(null)
  vi.spyOn(runtime, 'getMatchingLinearCreatedIssue').mockResolvedValue(null)
  vi.spyOn(runtime, 'notifyLinearLinkedIssueUpdated').mockReturnValue(undefined)
  const lost = () => {
    throw new LinearWriteFailure('unconfirmed', 'Confirmation lost')
  }
  vi.spyOn(mutations, 'updateIssueForAgent').mockImplementation(
    async (_id, _fields, _workspace, options) => {
      options?.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(mutations, 'createIssueForAgent').mockImplementation(
    async (_team, _title, _body, _workspace, options) => {
      options.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(comments, 'addIssueCommentForAgent').mockImplementation(
    async (_id, _body, _workspace, options) => {
      options.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(comments, 'createIssueAttachment').mockImplementation(
    async (_id, _input, _workspace, options) => {
      options?.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(comments, 'updateIssueCommentForAgent').mockImplementation(
    async (_id, _body, _workspace, options) => {
      options?.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(comments, 'deleteIssueCommentForAgent').mockImplementation(
    async (_id, _workspace, options) => {
      options?.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(relations, 'writeIssueRelation').mockImplementation(async (params) => {
    params.beforeInvoke?.()
    return lost()
  })
  server = new OrcaRuntimeRpcServer({ runtime, userDataPath, methods: LINEAR_AGENT_ACCESS_METHODS })
  await server.start()
})

afterEach(async () => {
  vi.useRealTimers()
  await server.stop()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = undefined
  rmSync(userDataPath, { recursive: true, force: true })
})

const verbs = [
  ['status', 'set', 'ENG-1', '--to', 'Done'],
  ['priority', 'set', 'ENG-1', '--to', 'high'],
  ['assignee', 'set', 'ENG-1', '--to-id', writeId],
  ['label', 'add', 'ENG-1', '--label', 'Bug'],
  ['estimate', 'set', 'ENG-1', '--to', '3'],
  ['due-date', 'set', 'ENG-1', '--to', '2026-11-01'],
  ['relation', 'add', 'ENG-1', '--related', 'ENG-2', '--type', 'blocks'],
  ['relation', 'remove', 'ENG-1', '--related', 'ENG-2', '--type', 'blocks'],
  ['comment', 'add', 'ENG-1', '--body', 'new', '--write-id', writeId],
  ['comment', 'edit', writeId, '--body', 'new'],
  ['comment', 'delete', writeId],
  ['attach', 'ENG-1', '--url', 'https://example.com', '--write-id', writeId],
  ['create', '--title', 'New', '--team', 'ENG', '--write-id', writeId],
  ['save-issue', 'ENG-1', '--title', 'New'],
  ['save-issue', '--title', 'New', '--team', 'ENG', '--write-id', writeId]
].map((argv) => ({ name: argv.slice(0, 2).join(' '), argv }))

it.each(verbs)(
  'preserves $name recovery through CLI, socket, admission and dispatch',
  async ({ argv }) => {
    await main(['linear', ...argv, '--json'], '/tmp')
    const envelope = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'linear_write_unconfirmed', data: { nextSteps: [expect.any(String)] } }
    })
    const nextSteps: string[] = envelope.error.data.nextSteps
    expect(nextSteps[0]).toContain('orca linear')
    if (argv.includes('--write-id')) {
      expect(nextSteps[0]).toContain(`--write-id=${writeId}`)
    }
    expect(process.exitCode).toBe(1)
    vi.mocked(console.error).mockClear()
    process.exitCode = undefined
    await main(['linear', ...argv], '/tmp')
    const stderr = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    for (const step of nextSteps) {
      expect(stderr).toContain(step)
    }
    expect(process.exitCode).toBe(1)
  }
)

it('returns a confirmed CLI write over the unchanged wire payload', async () => {
  vi.mocked(mutations.updateIssueForAgent).mockImplementation(
    async (_id, _fields, _workspace, options) => {
      options?.beforeInvoke?.()
      return { ...issue, state: { id: 'done', name: 'Done' } }
    }
  )
  await main(['linear', 'status', 'set', 'ENG-1', '--to', 'Done', '--json'], '/tmp')
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toMatchObject({
    ok: true,
    result: { state: { id: 'done' } }
  })
  expect(mutations.updateIssueForAgent).toHaveBeenCalledTimes(1)
  expect(process.exitCode).toBeUndefined()
})

it('ends a stalled CLI preparation before its client timeout without a late write', async () => {
  let release = () => {}
  let entered = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  vi.mocked(runtime.resolveLinearAgentWriteTarget).mockImplementation(() => {
    entered()
    return new Promise((resolve) => {
      release = () => resolve(target)
    })
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const pending = main(['linear', 'status', 'set', 'ENG-1', '--to', 'Done', '--json'], '/tmp')
  try {
    await started
    await vi.advanceTimersByTimeAsync(30_000)
    await pending
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toMatchObject({
      error: { code: 'linear_timeout' }
    })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(mutations.updateIssueForAgent).not.toHaveBeenCalled()
  } finally {
    release()
    await pending
  }
})

it('propagates real client socket timeout into preparation cancellation', async () => {
  let release = () => {}
  let cancelled = () => {}
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve
  })
  vi.mocked(runtime.resolveLinearAgentWriteTarget).mockImplementation((_params, signal) => {
    signal?.addEventListener('abort', () => cancelled(), { once: true })
    return new Promise((resolve) => {
      release = () => resolve(target)
    })
  })
  const client = new RuntimeClient(userDataPath, 30, null, null)
  try {
    await expect(
      client.call('linear.issueSetState', { input: 'ENG-1', to: 'Done' })
    ).rejects.toMatchObject({ code: 'runtime_timeout' })
    await aborted
    release()
    await new Promise((resolve) => setImmediate(resolve))
    expect(mutations.updateIssueForAgent).not.toHaveBeenCalled()
  } finally {
    release()
  }
})
