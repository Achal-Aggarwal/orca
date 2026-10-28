import { z } from 'zod'
import type {
  GitHubAssignableUser,
  GitHubPRFileViewedState
} from '../../shared/github/pull-request-types'
import { extractExecError } from '../git/exec-error'
import { ghExecFileAsync, ghRepoExecOptions, githubRepoContext } from './gh-utils'
import type { LocalGitExecOptions } from './gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from './github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'
import { getPRMetadata } from './pull-request-file-data'
import { getWorkItemParticipants } from './work-item-participants'

function detailContextQuery(includeContext: boolean): string {
  const context = includeContext
    ? `body
      headRefOid
      baseRefOid
      participants(first: 100) {
        nodes { login avatarUrl(size: 48) ... on User { name } }
      }`
    : ''
  return `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      ${context}
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`
}

const envelopeSchema = z.object({
  data: z
    .object({
      repository: z.object({ pullRequest: z.record(z.string(), z.unknown()).nullish() }).nullish()
    })
    .nullish(),
  errors: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])).optional() }))
    .optional()
})
const metadataSchema = z.object({
  body: z.string().nullable(),
  headRefOid: z.string().nullable(),
  baseRefOid: z.string().nullable()
})
const participantsSchema = z.object({
  nodes: z.array(
    z.object({ login: z.string(), avatarUrl: z.string(), name: z.string().nullish() }).nullable()
  )
})
const filesSchema = z.object({
  id: z.string(),
  files: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
    nodes: z.array(
      z
        .object({
          path: z.string(),
          viewerViewedState: z.enum(['VIEWED', 'UNVIEWED', 'DISMISSED']).nullable()
        })
        .nullable()
    )
  })
})

export type PRFileViewedStatesResult = {
  pullRequestId: string
  viewedStates: Map<string, GitHubPRFileViewedState>
}
type PRMetadata = Awaited<ReturnType<typeof getPRMetadata>>
type PRDetailContext = {
  metadata: PRMetadata
  participants: GitHubAssignableUser[]
  viewedStates: PRFileViewedStatesResult | null
}

function sourceFailed(envelope: z.infer<typeof envelopeSchema>, source: string): boolean {
  return Boolean(
    envelope.errors?.some(
      ({ path }) =>
        !path?.length ||
        path[0] !== 'repository' ||
        path[1] !== 'pullRequest' ||
        path.length < 3 ||
        path[2] === source
    )
  )
}

async function readPRDetailContext(
  repoPath: string,
  prNumber: number,
  repository: GitHubApiRepository | null,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions,
  includeContext: boolean
): Promise<Partial<PRDetailContext>> {
  if (!repository) {
    return {}
  }
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(repository)
  }
  const result: Partial<PRDetailContext> = {}
  const viewedStates = new Map<string, GitHubPRFileViewedState>()
  let after: string | null = null
  try {
    for (let fetched = 0; fetched < 300; fetched += 100) {
      if (repositoryRateLimitGuard(repository, 'graphql', ghOptions).blocked) {
        break
      }
      const firstPage = fetched === 0
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${detailContextQuery(includeContext && firstPage)}`,
        '-f',
        `owner=${repository.owner}`,
        '-f',
        `repo=${repository.repo}`,
        '-F',
        `number=${prNumber}`
      ]
      if (after) {
        args.push('-f', `after=${after}`)
      }
      noteRepositoryRateLimitSpend(repository, 'graphql', 1, ghOptions)
      let stdout: string
      try {
        stdout = (await ghExecFileAsync(args, ghOptions)).stdout
      } catch (error) {
        const partial = extractExecError(error).stdout
        if (!partial) {
          throw error
        }
        stdout = partial
      }
      const envelope = envelopeSchema.parse(JSON.parse(stdout))
      const pr = envelope.data?.repository?.pullRequest
      if (includeContext && firstPage) {
        const metadata = metadataSchema.safeParse(pr)
        if (
          metadata.success &&
          ['body', 'headRefOid', 'baseRefOid'].every((field) => !sourceFailed(envelope, field))
        ) {
          result.metadata = {
            body: metadata.data.body ?? '',
            ...(metadata.data.headRefOid ? { headSha: metadata.data.headRefOid } : {}),
            ...(metadata.data.baseRefOid ? { baseSha: metadata.data.baseRefOid } : {})
          }
        }
        const participants = participantsSchema.safeParse(pr?.participants)
        if (participants.success && !sourceFailed(envelope, 'participants')) {
          result.participants = participants.data.nodes.flatMap((user) =>
            user?.login ? [{ ...user, name: user.name ?? null }] : []
          )
        }
      }
      const files = filesSchema.safeParse(pr)
      if (!files.success || sourceFailed(envelope, 'files') || sourceFailed(envelope, 'id')) {
        break
      }
      for (const file of files.data.files.nodes) {
        if (file?.path && file.viewerViewedState) {
          viewedStates.set(file.path, file.viewerViewedState)
        }
      }
      const page = files.data.files.pageInfo
      if (!page.hasNextPage || fetched === 200) {
        result.viewedStates = { pullRequestId: files.data.id, viewedStates }
        break
      }
      if (!page.endCursor || page.endCursor === after) {
        break
      }
      after = page.endCursor
    }
  } catch {
    // A failed file page must not discard metadata and participants from the first page.
  }
  return result
}

export async function getPRDetailContext(
  repoPath: string,
  prNumber: number,
  repository: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRDetailContext> {
  const context = await readPRDetailContext(
    repoPath,
    prNumber,
    repository,
    connectionId,
    localGitOptions,
    true
  )
  const [metadata, participants, viewed] = await Promise.all([
    context.metadata ??
      getPRMetadata(repoPath, prNumber, repository, connectionId, localGitOptions),
    context.participants ??
      getWorkItemParticipants(
        repoPath,
        { number: prNumber, type: 'pr' },
        repository,
        connectionId,
        localGitOptions
      ),
    context.viewedStates !== undefined || context.metadata || context.participants
      ? context.viewedStates
      : readPRDetailContext(
          repoPath,
          prNumber,
          repository,
          connectionId,
          localGitOptions,
          false
        ).then((fallback) => fallback.viewedStates)
  ])
  return { metadata, participants, viewedStates: viewed ?? null }
}
