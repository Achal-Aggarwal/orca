import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalGitExecOptions } from './gh-utils'

const { exec, guard, spend } = vi.hoisted(() => ({
  exec: vi.fn(),
  guard: vi.fn(),
  spend: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: exec,
  githubRepoContext: (
    repoPath: string,
    connectionId: string | null,
    options: LocalGitExecOptions
  ) => ({
    repoPath,
    connectionId,
    ...options
  }),
  ghRepoExecOptions: ({ repoPath, ...options }: { repoPath: string }) => ({
    cwd: repoPath,
    ...options
  })
}))
vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: guard,
  noteRepositoryRateLimitSpend: spend
}))

import { getPRDetailContext } from './pull-request-detail-context'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const participant = { login: 'reviewer', name: null, avatarUrl: 'https://avatars/reviewer' }
const metadata = { body: 'PR body', headRefOid: 'head-sha', baseRefOid: 'base-sha' }
const files = {
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes: [{ path: 'src/changed.ts', viewerViewedState: 'VIEWED' }]
}

function response(
  pr: Record<string, unknown>,
  errors?: Record<string, unknown>[]
): { stdout: string } {
  return { stdout: JSON.stringify({ data: { repository: { pullRequest: pr } }, errors }) }
}

beforeEach(() => {
  vi.resetAllMocks()
  guard.mockReturnValue({ blocked: false })
})

describe('PR detail context requests', () => {
  it('returns metadata, participants and viewed files in one authenticated request', async () => {
    exec.mockResolvedValueOnce(
      response({ id: 'PR_42', ...metadata, participants: { nodes: [participant, null] }, files })
    )

    const result = await getPRDetailContext('/folder-workspace', 42, repository)

    expect(result.metadata).toEqual({ body: 'PR body', headSha: 'head-sha', baseSha: 'base-sha' })
    expect(result.participants).toEqual([participant])
    expect(result.viewedStates).toEqual({
      pullRequestId: 'PR_42',
      viewedStates: new Map([['src/changed.ts', 'VIEWED']])
    })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0][1]).toMatchObject({ cwd: '/folder-workspace', host: 'github.com' })
    expect(spend).toHaveBeenCalledTimes(1)
    expect(spend).toHaveBeenCalledWith(repository, 'graphql', 1, expect.anything())
  })

  it('paginates only files after the first page and retains nullable viewer states', async () => {
    exec
      .mockResolvedValueOnce(
        response({
          id: 'PR_42',
          ...metadata,
          participants: { nodes: [] },
          files: { ...files, pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } }
        })
      )
      .mockResolvedValueOnce(
        response({
          id: 'PR_42',
          files: {
            ...files,
            nodes: [null, { path: 'src/unknown.ts', viewerViewedState: null }]
          }
        })
      )

    const result = await getPRDetailContext('/repo', 42, repository)

    expect(result.metadata.body).toBe('PR body')
    expect(result.viewedStates?.viewedStates).toEqual(new Map([['src/changed.ts', 'VIEWED']]))
    expect(exec).toHaveBeenCalledTimes(2)
    const nextArgs: string[] = exec.mock.calls[1][0]
    expect(nextArgs).toContain('after=cursor-1')
    expect(nextArgs.find((arg) => arg.startsWith('query='))).not.toMatch(/participants|headRefOid/)
  })

  it('accepts successful empty sources without issuing recovery requests', async () => {
    exec.mockResolvedValueOnce(
      response({
        id: 'PR_42',
        body: '',
        headRefOid: null,
        baseRefOid: null,
        participants: { nodes: [] },
        files: { ...files, nodes: [] }
      })
    )

    const result = await getPRDetailContext('/repo', 42, repository)

    expect(result).toEqual({
      metadata: { body: '' },
      participants: [],
      viewedStates: { pullRequestId: 'PR_42', viewedStates: new Map() }
    })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('recovers only failed metadata from a nonzero partial GraphQL response', async () => {
    exec
      .mockRejectedValueOnce({
        code: 1,
        ...response({ id: 'PR_42', ...metadata, participants: { nodes: [participant] }, files }, [
          { path: ['repository', 'pullRequest', 'headRefOid'] }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ body: 'Recovered body', head: { sha: 'new-head' } })
      })

    const result = await getPRDetailContext('/repo', 42, repository)

    expect(result.metadata).toEqual({ body: 'Recovered body', headSha: 'new-head' })
    expect(result.participants).toEqual([participant])
    expect(result.viewedStates?.viewedStates.get('src/changed.ts')).toBe('VIEWED')
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[1][0]).toContain('repos/acme/widgets/pulls/42')
  })

  it('recovers participants without repeating successful metadata or file reads', async () => {
    exec
      .mockResolvedValueOnce(
        response({ id: 'PR_42', ...metadata, participants: null, files }, [
          { path: ['repository', 'pullRequest', 'participants'] }
        ])
      )
      .mockResolvedValueOnce(response({ participants: { nodes: [participant] } }))

    const result = await getPRDetailContext('/repo', 42, repository)

    expect(result.metadata.body).toBe('PR body')
    expect(result.participants).toEqual([participant])
    expect(result.viewedStates?.pullRequestId).toBe('PR_42')
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[1][0].join(' ')).not.toContain('viewerViewedState')
  })

  it('does not publish partially paginated viewed files after a later page fails', async () => {
    exec
      .mockResolvedValueOnce(
        response({
          id: 'PR_42',
          ...metadata,
          participants: { nodes: [participant] },
          files: { ...files, pageInfo: { hasNextPage: true, endCursor: 'next' } }
        })
      )
      .mockRejectedValueOnce(new Error('file page unavailable'))

    const result = await getPRDetailContext('/repo', 42, repository)

    expect(result.metadata.body).toBe('PR body')
    expect(result.participants).toEqual([participant])
    expect(result.viewedStates).toBeNull()
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('keeps the three-page file bound without resending context fields', async () => {
    exec.mockImplementation(async () =>
      response({
        id: 'PR_42',
        ...metadata,
        participants: { nodes: [] },
        files: {
          nodes: files.nodes,
          pageInfo: { hasNextPage: true, endCursor: `cursor-${exec.mock.calls.length}` }
        }
      })
    )

    const result = await getPRDetailContext('/repo', 42, repository)

    expect(result.viewedStates?.pullRequestId).toBe('PR_42')
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('retains legacy reads when a host rejects the combined query', async () => {
    exec.mockImplementation(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('headRefOid')) {
        throw new Error('unsupported field')
      }
      if (query.includes('viewerViewedState')) {
        return response({ id: 'PR_42', files })
      }
      if (query.includes('participants')) {
        return response({ participants: { nodes: [participant] } })
      }
      return { stdout: JSON.stringify({ body: 'REST body', head: { sha: 'rest-head' } }) }
    })

    const result = await getPRDetailContext('/repo', 42, repository)

    expect(result.metadata).toEqual({ body: 'REST body', headSha: 'rest-head' })
    expect(result.participants).toEqual([participant])
    expect(result.viewedStates?.pullRequestId).toBe('PR_42')
    expect(exec).toHaveBeenCalledTimes(4)
  })

  it('can load all context with no remaining REST quota', async () => {
    guard.mockImplementation((_, bucket: string) => ({ blocked: bucket === 'core' }))
    exec.mockResolvedValueOnce(
      response({ id: 'PR_42', ...metadata, participants: { nodes: [] }, files })
    )

    const result = await getPRDetailContext('/repo', 42, repository)

    expect(result.metadata.headSha).toBe('head-sha')
    expect(result.viewedStates?.pullRequestId).toBe('PR_42')
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it.each([{ wslDistro: 'Ubuntu' }, {}])('keeps host and execution routing %j', async (options) => {
    exec.mockResolvedValueOnce(
      response({ id: 'PR_42', ...metadata, participants: { nodes: [] }, files })
    )

    await getPRDetailContext(
      '/remote/repo',
      42,
      { ...repository, host: 'ghe.example.com' },
      'ssh-1',
      options
    )

    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0][1]).toMatchObject({
      cwd: '/remote/repo',
      connectionId: 'ssh-1',
      host: 'ghe.example.com',
      ...options
    })
  })
})
