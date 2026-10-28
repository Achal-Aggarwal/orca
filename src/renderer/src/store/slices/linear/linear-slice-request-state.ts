import {
  abandonLinearIssueReads,
  invalidateLinearIssueReads,
  type LinearIssueRequest
} from './linear-issue-publication'
import { rowLessSourceTarget } from '@/lib/default-creation-host'
import type { LinearSlice } from './linear-slice-contract'
import type { LinearReadScope } from './linear-slice-scope'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearTeam
} from '../../../../../shared/linear/workspace-types'
import { clearLinearMetadataCache } from '../../../hooks/useIssueMetadata'

export type InflightLinearIssueRequest = LinearIssueRequest<LinearIssue | null>
export type InflightLinearListRequest = LinearIssueRequest<LinearIssue[]>
export type InflightLinearPlainListRequest = LinearIssueRequest<LinearCollectionResult<LinearIssue>>

export type InflightLinearCollectionRequest<T> = {
  promise: Promise<LinearCollectionResult<T>>
  generation: number
  contextKey: string
  mutationGeneration: number
}

export type InflightLinearDetailRequest<T> = {
  promise: Promise<T>
  contextKey: string
  mutationGeneration: number
}

export type InflightLinearTeamRequest = {
  promise: Promise<LinearTeam[]>
  generation: number
  contextKey: string
  mutationGeneration: number
}

export const linearRequestState = {
  issueRequests: new Map<string, InflightLinearIssueRequest>(),
  searchRequests: new Map<string, InflightLinearListRequest>(),
  listRequests: new Map<string, InflightLinearPlainListRequest>(),
  teamRequests: new Map<string, InflightLinearTeamRequest>(),
  projectRequests: new Map<string, InflightLinearCollectionRequest<LinearProjectSummary>>(),
  projectDetailRequests: new Map<string, InflightLinearDetailRequest<LinearProjectDetail | null>>(),
  projectIssueRequests: new Map<string, InflightLinearPlainListRequest>(),
  customViewRequests: new Map<string, InflightLinearCollectionRequest<LinearCustomViewSummary>>(),
  customViewDetailRequests: new Map<
    string,
    InflightLinearDetailRequest<LinearCustomViewSummary | null>
  >(),
  customViewIssueRequests: new Map<string, InflightLinearPlainListRequest>(),
  customViewProjectRequests: new Map<
    string,
    InflightLinearCollectionRequest<LinearProjectSummary>
  >(),
  inflightStatusRequest: null as { contextKey: string; promise: Promise<void> } | null,
  statusReadGeneration: 0,
  mutationGeneration: 0,
  cacheGeneration: 0
}

export const inflightIssueRequests = linearRequestState.issueRequests
export const inflightSearchRequests = linearRequestState.searchRequests
export const inflightListRequests = linearRequestState.listRequests
export const inflightTeamRequests = linearRequestState.teamRequests
export const inflightProjectRequests = linearRequestState.projectRequests
export const inflightProjectDetailRequests = linearRequestState.projectDetailRequests
export const inflightProjectIssueRequests = linearRequestState.projectIssueRequests
export const inflightCustomViewRequests = linearRequestState.customViewRequests
export const inflightCustomViewDetailRequests = linearRequestState.customViewDetailRequests
export const inflightCustomViewIssueRequests = linearRequestState.customViewIssueRequests
export const inflightCustomViewProjectRequests = linearRequestState.customViewProjectRequests

export function clearLinearRequestMaps(): void {
  abandonLinearIssueReads()
  clearLinearMetadataRequests()
}

function clearLinearMetadataRequests(): void {
  linearRequestState.teamRequests.clear()
  linearRequestState.projectRequests.clear()
  linearRequestState.projectDetailRequests.clear()
  linearRequestState.customViewRequests.clear()
  linearRequestState.customViewDetailRequests.clear()
  linearRequestState.customViewProjectRequests.clear()
}

export function invalidateLinearCaches(scope: LinearReadScope): void {
  linearRequestState.cacheGeneration += 1
  clearLinearMetadataRequests()
  clearLinearMetadataCache()
  invalidateLinearIssueReads(scope, undefined, true)
}

export function beginLinearMutation(): number {
  linearRequestState.mutationGeneration += 1
  linearRequestState.inflightStatusRequest = null
  return linearRequestState.mutationGeneration
}

export function isCurrentLinearMutation(generation: number): boolean {
  return generation === linearRequestState.mutationGeneration
}

export function nextLinearStatusReadGeneration(): number {
  linearRequestState.statusReadGeneration += 1
  return linearRequestState.statusReadGeneration
}

export function isCurrentLinearStatusRead(generation: number): boolean {
  return generation === linearRequestState.statusReadGeneration
}

export function getLinearCacheGeneration(): number {
  return linearRequestState.cacheGeneration
}

export function getLinearMutationGeneration(): number {
  return linearRequestState.mutationGeneration
}

export function getInflightStatusRequest(): {
  contextKey: string
  promise: Promise<void>
} | null {
  return linearRequestState.inflightStatusRequest
}

export function setInflightStatusRequest(
  request: { contextKey: string; promise: Promise<void> } | null
): void {
  linearRequestState.inflightStatusRequest = request
}

export function evictLinearScopeCaches(state: LinearSlice, scope: LinearReadScope) {
  const target = rowLessSourceTarget(scope.settings)
  const host = target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'
  const prefix = `linear:${encodeURIComponent(host)}:`
  const retain = <T>(cache: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(cache).filter(([key]) => key.startsWith('linear:') && !key.startsWith(prefix))
    )
  return {
    linearIssueCache: retain(state.linearIssueCache),
    linearSearchCache: retain(state.linearSearchCache),
    linearListCache: retain(state.linearListCache),
    linearTeamCache: retain(state.linearTeamCache),
    linearProjectCache: retain(state.linearProjectCache),
    linearProjectDetailCache: retain(state.linearProjectDetailCache),
    linearProjectIssueCache: retain(state.linearProjectIssueCache),
    linearCustomViewCache: retain(state.linearCustomViewCache),
    linearCustomViewDetailCache: retain(state.linearCustomViewDetailCache),
    linearCustomViewIssueCache: retain(state.linearCustomViewIssueCache),
    linearCustomViewProjectCache: retain(state.linearCustomViewProjectCache)
  }
}
