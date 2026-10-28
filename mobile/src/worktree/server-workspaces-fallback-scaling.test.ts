import { expect, it, vi } from 'vitest'
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { Worktree } from './workspace-list-types'
import {
  applyServerWorkspaces,
  fetchServerWorkspaces,
  type ServerWorkspaces
} from './server-workspaces'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'

vi.mock('react-native', () => ({}))

function host(index: number): MobileRelayHost {
  return {
    hostId: `runtime:server-${index}`,
    label: `Server ${index}`,
    health: 'available',
    relay: 'ready'
  }
}
function row(hostId: ExecutionHostId, worktreeId: string): Worktree {
  return {
    hostId,
    worktreeId,
    repoId: 'folder:repo',
    repo: 'folder',
    branch: '',
    displayName: worktreeId,
    path: '/workspace',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

it.each([10, 100])(
  'visits cached rows once while %i server reads fail, then recovers one server',
  async (count) => {
    const hosts = Array.from({ length: count }, (_, index) => host(index))
    let hostReads = 0
    const previous: ServerWorkspaces = {
      hosts,
      worktrees: hosts.flatMap((server, index) =>
        [0, 1].map((slot) => ({
          ...row(server.hostId, `same-${slot}`),
          get hostId() {
            hostReads += 1
            return server.hostId
          },
          displayName: `${index}-${slot}`
        }))
      )
    }
    const calls: string[] = []
    const client = stubRpcClient({
      sendRequest: async (method): Promise<RpcResponse> => {
        calls.push(method)
        if (method === 'mobileRelay.hosts.list') {
          return { id: 'hosts', ok: true, result: { hosts }, _meta: { runtimeId: 'server' } }
        }
        return {
          id: 'rows',
          ok: false,
          error: { code: 'unavailable', message: 'Server offline' },
          _meta: { runtimeId: 'server' }
        }
      }
    })
    const fetched = await fetchServerWorkspaces(client)
    if (!fetched) {
      throw new Error('Fixture did not list server hosts')
    }
    const unchanged = applyServerWorkspaces(previous, fetched)
    expect(unchanged).toBe(previous)
    const visits = hostReads
    const recovered = row(hosts[0]!.hostId, 'recovered')
    const nextHosts = hosts.slice(0, -1).map((server) => ({ ...server }))
    const next = applyServerWorkspaces(previous, {
      hosts: nextHosts,
      rows: nextHosts.map((_, index) => (index === 0 ? [recovered] : null))
    })
    const expectedRows = [recovered, ...previous.worktrees.slice(2, -2)]
    expect(next.worktrees).toEqual(expectedRows)
    expectedRows.forEach((expected, index) => expect(next.worktrees[index]).toBe(expected))
    expect(next.hosts).toEqual(nextHosts)
    expect(calls.filter((method) => method !== 'mobileRelay.hosts.list')).toHaveLength(count)
    expect(visits).toBeLessThanOrEqual(count * 2)
  }
)

it('does not inspect cached row ownership when every server supplies fresh rows', () => {
  const server = host(0)
  let reads = 0
  const previous: ServerWorkspaces = {
    hosts: [server],
    worktrees: [
      {
        ...row(server.hostId, 'old'),
        get hostId() {
          reads += 1
          return server.hostId
        }
      }
    ]
  }
  const next = applyServerWorkspaces(previous, {
    hosts: [{ ...server, label: 'Renamed' }],
    rows: [[row(server.hostId, 'fresh')]]
  })
  expect(next.worktrees.map((entry) => entry.worktreeId)).toEqual(['fresh'])
  expect(reads).toBe(0)
})
