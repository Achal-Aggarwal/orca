import type { ResolveProjectExecutionRuntimeArgs } from '../../../shared/project-execution-runtime'
import {
  getProjectHostSetupProjectionFromState,
  type ProjectCatalogReadState
} from '@/store/project-host-setup-selector'
import { getProjectHostSetupLookup } from '../../../shared/project-host-setup-lookup'
import type { AppState } from '@/store/types'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost,
  type FolderWorkspaceHostState
} from '../../../shared/folder-workspace-execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type RuntimeWorkspaceState = Pick<AppState, 'activeWorktreeId' | 'repos' | 'worktreesByRepo'> &
  Partial<Pick<AppState, 'folderWorkspaces' | 'projectGroups'>>

export type LocalProjectRuntimeState = Pick<
  AppState,
  'activeRepoId' | 'activeWorktreeId' | 'repos' | 'settings' | 'worktreesByRepo'
> &
  Partial<Pick<AppState, 'folderWorkspaces' | 'projectGroups'>> &
  ProjectCatalogReadState

const EMPTY_WORKTREES_BY_REPO: AppState['worktreesByRepo'] = {}

const EMPTY_FOLDERS: NonNullable<RuntimeWorkspaceState['folderWorkspaces']> = []
const EMPTY_GROUPS: NonNullable<RuntimeWorkspaceState['projectGroups']> = []
type RuntimeWorkspace = Pick<
  Worktree,
  | 'id'
  | 'repoId'
  | 'projectId'
  | 'path'
  | 'hostId'
  | 'projectHostSetupId'
  | 'runtimeOwnerEnvironmentId'
> | null
const folderIndexes = new WeakMap<
  typeof EMPTY_FOLDERS,
  Map<string, (typeof EMPTY_FOLDERS)[number]>
>()
const groupIndexes = new WeakMap<typeof EMPTY_GROUPS, Map<string, (typeof EMPTY_GROUPS)[number]>>()
const folderRuntimeCache = new WeakMap<
  (typeof EMPTY_FOLDERS)[number],
  WeakMap<typeof EMPTY_GROUPS, WeakMap<AppState['repos'], { workspace: RuntimeWorkspace }>>
>()

function firstById<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  const byId = new Map<string, T>()
  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row)
    }
  }
  return byId
}

function getIndexedFolder(folders: typeof EMPTY_FOLDERS, id: string) {
  let byId = folderIndexes.get(folders)
  if (!byId) {
    byId = firstById(folders)
    folderIndexes.set(folders, byId)
  }
  return byId.get(id)
}

export function createLocalProjectRuntimeWorkspaceSelector(): typeof getLocalProjectRuntimeWorkspace {
  let previous: readonly unknown[] | undefined
  let workspace: RuntimeWorkspace = null
  return (state, worktreeId) => {
    const scope = parseWorkspaceKey(worktreeId ?? state.activeWorktreeId ?? '')
    if (scope?.type !== 'folder') {
      previous = undefined
      workspace = null
      return getLocalProjectRuntimeWorkspace(state, worktreeId)
    }
    const folder = getIndexedFolder(
      state.folderWorkspaces ?? EMPTY_FOLDERS,
      scope.folderWorkspaceId
    )
    const facts = [
      scope.folderWorkspaceId,
      folder?.folderPath,
      folder?.projectGroupId,
      folder?.executionHostId,
      folder?.connectionId,
      state.projectGroups,
      state.repos
    ]
    if (!previous || facts.some((value, index) => value !== previous?.[index])) {
      previous = facts
      workspace = getLocalProjectRuntimeWorkspace(state, worktreeId)
    }
    return workspace
  }
}

export function getLocalProjectRuntimeWorkspace(
  state: RuntimeWorkspaceState,
  worktreeId?: string | null
): RuntimeWorkspace {
  const targetWorktreeId = worktreeId ?? state.activeWorktreeId
  if (!targetWorktreeId) {
    return null
  }
  const scope = parseWorkspaceKey(targetWorktreeId)
  if (scope?.type !== 'folder') {
    return (
      getIndexedWorktreeById(
        selectWorktreesByRepo(state) ?? EMPTY_WORKTREES_BY_REPO,
        targetWorktreeId
      ) ?? null
    )
  }
  const folders = state.folderWorkspaces ?? EMPTY_FOLDERS
  const groups = state.projectGroups ?? EMPTY_GROUPS
  const folder = getIndexedFolder(folders, scope.folderWorkspaceId)
  if (!folder) {
    return null
  }
  let byGroups = folderRuntimeCache.get(folder)
  if (!byGroups) {
    byGroups = new WeakMap()
    folderRuntimeCache.set(folder, byGroups)
  }
  let byRepos = byGroups.get(groups)
  if (!byRepos) {
    byRepos = new WeakMap()
    byGroups.set(groups, byRepos)
  }
  const cached = byRepos.get(state.repos)
  if (cached) {
    return cached.workspace
  }
  let groupById = groupIndexes.get(groups)
  if (!groupById) {
    groupById = firstById(groups)
    groupIndexes.set(groups, groupById)
  }
  const folderState = { folderWorkspaces: folders, projectGroups: groups, repos: state.repos }
  const result = resolveLocalFolderRuntimeWorkspace(
    folderState,
    targetWorktreeId,
    folder,
    groupById.get(folder.projectGroupId)
  )
  byRepos.set(state.repos, { workspace: result })
  return result
}

function resolveLocalFolderRuntimeWorkspace(
  folderState: FolderWorkspaceHostState,
  targetWorktreeId: string,
  folder: (typeof EMPTY_FOLDERS)[number],
  group: (typeof EMPTY_GROUPS)[number] | undefined
): RuntimeWorkspace {
  if (resolveFolderWorkspaceHost(folderState, folder.id).kind !== 'local') {
    return null
  }
  if (
    (folder.executionHostId ?? group?.executionHostId ?? LOCAL_EXECUTION_HOST_ID) !==
    LOCAL_EXECUTION_HOST_ID
  ) {
    return null
  }
  const candidates = findFolderWorkspaceCandidateRepos(folderState, folder.id)
  const repo = candidates.length === 1 ? candidates[0] : undefined
  return repo && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
    ? {
        id: targetWorktreeId,
        repoId: repo.id,
        path: folder.folderPath,
        hostId: LOCAL_EXECUTION_HOST_ID
      }
    : null
}

export function getLocalPreflightProjectId(
  state: RuntimeWorkspaceState & Pick<AppState, 'activeRepoId'> & ProjectCatalogReadState,
  worktreeId?: string | null,
  readWorkspace = getLocalProjectRuntimeWorkspace
): string {
  const activeWorktree = readWorkspace(state, worktreeId)
  return (
    (activeWorktree
      ? getProjectHostSetupLookup(getProjectHostSetupProjectionFromState(state).setups).projectId(
          activeWorktree
        )
      : undefined) ??
    activeWorktree?.repoId ??
    state.activeRepoId ??
    'local-project'
  )
}

export function getGlobalWindowsExecutionRuntimeInput(
  state: LocalProjectRuntimeState,
  worktreeId: string | null | undefined,
  appPlatform: NodeJS.Platform,
  wslContext: Pick<ResolveProjectExecutionRuntimeArgs, 'wslAvailable' | 'availableWslDistros'>,
  readWorkspace = getLocalProjectRuntimeWorkspace
): ResolveProjectExecutionRuntimeArgs | undefined {
  if (
    appPlatform !== 'win32' ||
    worktreeId ||
    state.activeRepoId ||
    state.activeWorktreeId ||
    !state.settings?.localWindowsRuntimeDefault
  ) {
    return undefined
  }
  return {
    appPlatform: 'win32',
    projectId: getLocalPreflightProjectId(state, worktreeId, readWorkspace),
    projectRuntimePreference: { kind: 'inherit-global' },
    globalWindowsRuntimeDefault: state.settings.localWindowsRuntimeDefault,
    ...wslContext
  }
}
