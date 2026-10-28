import '../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../main/runtime/orca-runtime'
import { RpcDispatcher } from '../main/runtime/rpc/dispatcher'
import { LINEAR_AGENT_ACCESS_METHODS } from '../main/runtime/rpc/methods/linear-agent-access'
import { RuntimeLinearCommands } from '../main/runtime/runtime-linear-connection-commands'
import { connect, getClient, testConnection } from '../main/linear/client'
import { updateIssueForAgent } from '../main/linear/linear-issue-mutations'
import { writeIssueRelation } from '../main/linear/issue-relation-write'
import { sendLinearData, serveLinearHttp } from '../main/linear/linear-sdk-http.test-fixture'
import { RuntimeRpcFailureError } from './runtime/types'
import { main } from './index'

const boundary = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/unused-qa-runtime'),
  save: vi.fn(),
  upsert: vi.fn(),
  workspace: {
    id: 'workspace-proof',
    organizationId: 'workspace-proof',
    organizationName: 'Proof',
    organizationUrlKey: 'proof',
    displayName: 'Proof viewer',
    email: 'proof@example.invalid'
  }
}))
vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness')
  return createRuntimeClientModuleMock(boundary)
})
vi.mock('../main/linear/linear-token-store', () => ({
  loadToken: () => 'local-proof-token',
  saveWorkspaceToken: boundary.save,
  getWorkspaceTokenProtection: () => null,
  clearToken: vi.fn(),
  clearTokenFile: vi.fn(),
  replaceLegacyWorkspace: vi.fn()
}))
vi.mock('../main/linear/linear-workspace-registry', () => ({
  getWorkspaceState: () => ({
    workspaces: [boundary.workspace],
    activeWorkspaceId: boundary.workspace.id,
    selectedWorkspaceId: boundary.workspace.id
  }),
  resolveWorkspaceId: (id?: string) => id ?? boundary.workspace.id,
  getCredentialError: () => undefined,
  getLegacyWorkspace: () => null,
  getWorkspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  upsertWorkspace: boundary.upsert
}))

const issue = {
  id: 'issue-proof',
  identifier: 'ENG-1',
  title: 'Recovered issue',
  url: 'https://linear.app/proof/issue/ENG-1',
  team: { id: 'team-proof', key: 'ENG', name: 'Engineering' },
  state: { id: 'state-proof', name: 'Todo', type: 'unstarted', color: '' },
  parent: null,
  assignee: null,
  priority: 2,
  updatedAt: '2026-10-28T00:00:00.000Z',
  labels: { nodes: [] }
}
const relatedIssue = {
  id: 'related-proof',
  identifier: 'ENG-2',
  title: 'Related',
  url: 'https://linear.app/proof/issue/ENG-2'
}
const nativeFetch = globalThis.fetch
let server: Awaited<ReturnType<typeof serveLinearHttp>>
let counts: Map<string, number>
let signals: (AbortSignal | null | undefined)[]
let persistent = false
let dropMutation = false
let previousExitCode: typeof process.exitCode

beforeEach(async () => {
  vi.clearAllMocks()
  counts = new Map()
  signals = []
  persistent = false
  dropMutation = false
  previousExitCode = process.exitCode
  for (const key of [
    'ORCA_ENVIRONMENT',
    'ORCA_PAIRING_CODE',
    'ORCA_REMOTE_PAIRING',
    'ORCA_TERMINAL_HANDLE',
    'ORCA_WORKSPACE_ID',
    'ORCA_WORKTREE_ID'
  ]) {
    vi.stubEnv(key, '')
  }
  server = await serveLinearHttp((receipt, response) => {
    const operation = /\b(?:query|mutation)\s+(\w+)/.exec(receipt.query)?.[1] ?? 'unknown'
    const count = (counts.get(operation) ?? 0) + 1
    counts.set(operation, count)
    const mutation = /^\s*mutation\b/.test(receipt.query)
    if ((mutation && dropMutation) || (!mutation && (persistent || count === 1))) {
      response.destroy()
      return
    }
    const connection = { nodes: [issue], pageInfo: { hasNextPage: false } }
    if (operation === 'OrcaAgentLinearIssueRelations') {
      sendLinearData(response, {
        issue: {
          relations: {
            nodes: [{ id: 'relation-proof', type: 'blocks', issue, relatedIssue }],
            pageInfo: { hasNextPage: false }
          }
        }
      })
    } else if (operation === 'OrcaAgentLinearIssue' || operation === 'OrcaLinearIssueByUuid') {
      sendLinearData(response, { issue })
    } else if (operation === 'OrcaAgentLinearSearch') {
      sendLinearData(response, { searchIssues: connection })
    } else if (operation === 'OrcaLinearIssues') {
      sendLinearData(response, { issues: connection })
    } else if (operation === 'OrcaLinearProjects') {
      sendLinearData(response, {
        projects: {
          nodes: [
            {
              id: 'project-proof',
              name: 'Recovered project',
              url: 'https://linear.app/proof/project/project-proof'
            }
          ],
          pageInfo: { hasNextPage: false }
        }
      })
    } else if (operation === 'viewer') {
      sendLinearData(response, {
        viewer: {
          id: 'viewer-proof',
          displayName: boundary.workspace.displayName,
          email: boundary.workspace.email
        }
      })
    } else if (operation === 'organization') {
      sendLinearData(response, {
        organization: {
          id: boundary.workspace.id,
          name: boundary.workspace.organizationName,
          urlKey: boundary.workspace.organizationUrlKey,
          projectStatuses: []
        }
      })
    } else if (mutation && receipt.query.includes('issueUpdate')) {
      sendLinearData(response, { issueUpdate: { success: true } })
    } else {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ errors: [{ message: `Unexpected operation ${operation}` }] }))
    }
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input) !== 'https://api.linear.app/graphql') {
      throw new Error('Unexpected SDK endpoint')
    }
    signals.push(init?.signal)
    return nativeFetch(server.apiUrl, init)
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const runtime = Object.assign(
    new RuntimeLinearCommands({
      runtimeAvailable: () => true,
      showTerminal: async () => {
        throw new Error('Unexpected terminal')
      },
      resolveWorktreeSelector: async () => {
        throw new Error('Unexpected workspace lookup')
      },
      listResolvedWorktrees: async () => [],
      setWorktreeMeta: () => {
        throw new Error('Unexpected metadata write')
      },
      emitClientEvent: () => {
        throw new Error('Unexpected event')
      }
    }),
    { getRuntimeId: () => 'runtime-proof' }
  )
  // SAFETY: the explicit Linear registry uses only this real Linear command surface and runtime ID.
  const dispatcher = new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: LINEAR_AGENT_ACCESS_METHODS
  })
  boundary.callMock.mockImplementation(async (method: string, params: unknown) => {
    const response = await dispatcher.dispatch({
      id: 'request-proof',
      authToken: 'proof',
      method,
      params
    })
    if (!response.ok) {
      throw new RuntimeRpcFailureError(response)
    }
    return response
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = previousExitCode
  await server.close()
})

it('parses and dispatches issue, search, list and project commands through real recovering read handlers', async () => {
  for (const args of [
    ['issue', 'ENG-1'],
    ['search', '--query', 'recovery'],
    ['list', '--filter', 'all', '--limit', '1'],
    ['project', 'list', '--limit', '1']
  ]) {
    await main(['linear', ...args, '--workspace', boundary.workspace.id, '--json'])
    expect(process.exitCode).toBe(previousExitCode)
  }
  const output = vi.mocked(console.log).mock.calls.map(([value]) => JSON.parse(String(value)))
  expect(output).toHaveLength(4)
  expect(output[0]).toMatchObject({
    ok: true,
    result: { issue: { identifier: issue.identifier }, meta: { partial: false } }
  })
  expect(output[1]).toMatchObject({
    ok: true,
    result: { issues: [{ identifier: issue.identifier }] }
  })
  expect(output[2]).toMatchObject({
    ok: true,
    result: { issues: [{ priority: 2, priorityLabel: 'high' }], truncated: false }
  })
  expect(output[3]).toMatchObject({
    ok: true,
    result: { projects: [{ id: 'project-proof', name: 'Recovered project' }], truncated: false }
  })
  expect([...counts.entries()]).toEqual([
    ['OrcaAgentLinearIssue', 2],
    ['OrcaAgentLinearSearch', 2],
    ['OrcaLinearIssues', 2],
    ['OrcaLinearProjects', 2]
  ])
  expect(server.receipts).toHaveLength(8)
  expect(
    server.receipts.slice(0, 2).map((receipt) => receipt.headers['public-file-urls-expire-in'])
  ).toEqual(['3600', '3600'])
  expect(
    server.receipts.every((receipt) => receipt.headers.authorization === 'local-proof-token')
  ).toBe(true)
  expect(server.receipts[2].variables).toMatchObject({ term: 'recovery' })
  expect(boundary.callMock.mock.calls.map(([method]) => method)).toEqual([
    'linear.issueContext',
    'linear.agentSearchIssues',
    'linear.agentIssueList',
    'linear.agentProjectList'
  ])
})

it('keeps the existing CLI failure envelope after exhausted real socket resets', async () => {
  persistent = true
  await main(['linear', 'issue', 'ENG-1', '--workspace', boundary.workspace.id, '--json'])
  const output = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .map(([value]) => String(value))
    .join('\n')
  expect(JSON.parse(output)).toMatchObject({
    ok: false,
    error: { code: 'linear_network_error', message: 'fetch failed' }
  })
  expect(output).not.toContain('UND_ERR_SOCKET')
  expect(output).not.toContain('local-proof-token')
  expect(server.receipts).toHaveLength(3)
  expect(process.exitCode).toBe(1)
})

it('applies recovery at connect, connection-test and legacy getClient constructor sites', async () => {
  const client = getClient(boundary.workspace.id)
  assert(client)
  await expect(client.viewer).resolves.toMatchObject({ id: 'viewer-proof' })
  expect([...counts.values()]).toEqual([2])
  for (const invoke of [
    () => connect('local-proof-token'),
    () => testConnection(boundary.workspace.id)
  ]) {
    counts.clear()
    await expect(invoke()).resolves.toMatchObject({ ok: true, workspace: boundary.workspace })
    expect([...counts.entries()]).toEqual([
      ['viewer', 2],
      ['organization', 2]
    ])
  }
  expect(boundary.save).toHaveBeenCalledTimes(2)
})

it('retries only the readback after a successful mutation and recovers signal-bound relation reads', async () => {
  const signal = new AbortController().signal
  await expect(
    updateIssueForAgent(issue.id, { title: issue.title }, boundary.workspace.id, { signal })
  ).resolves.toMatchObject({ id: issue.id })
  expect(server.receipts).toHaveLength(3)
  expect(server.receipts.map((receipt) => receipt.query.trimStart().split(' ')[0])).toEqual([
    'mutation',
    'query',
    'query'
  ])
  expect(server.receipts[0].variables).toMatchObject({
    id: issue.id,
    input: { title: issue.title }
  })
  expect(signals.every((received) => received === signal)).toBe(true)
  counts.clear()
  signals = []
  await expect(
    writeIssueRelation({
      issue,
      relatedIssue,
      operation: 'add',
      relationship: 'blocks',
      workspaceId: boundary.workspace.id,
      signal
    })
  ).resolves.toMatchObject({ meta: { alreadySet: true } })
  expect([...counts.entries()]).toEqual([['OrcaAgentLinearIssueRelations', 2]])
  expect(signals).toEqual([signal, signal])
  counts.clear()
  dropMutation = true
  const before = server.receipts.length
  await expect(
    updateIssueForAgent(issue.id, { title: 'Unconfirmed' }, boundary.workspace.id, { signal })
  ).rejects.toMatchObject({ kind: 'unconfirmed' })
  expect(server.receipts).toHaveLength(before + 1)
  expect([...counts.values()]).toEqual([1])
})
