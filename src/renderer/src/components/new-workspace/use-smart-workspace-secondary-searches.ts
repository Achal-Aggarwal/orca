import {
  observeLinearIssueRead,
  mapLinearIssueRead,
  type LinearIssueRead
} from '@/store/slices/linear/linear-issue-publication'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearCollectionResult } from '../../../../shared/linear/workspace-types'
import { linearIssueReadError } from '@/lib/linear-read-error'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { useEffect, useMemo, useRef } from 'react'
import { searchRuntimeRepoBaseRefDetails } from '@/runtime/runtime-repo-client'
import { lookupLinearIssueUrl } from '@/lib/linear-issue-url-lookup'
import { searchJiraIssuesByKeyOrText } from '@/components/jira-key-or-text-search'
import { linearWorkspaceScopeSignature } from '../../../../shared/linear/workspace-types'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import { getSmartWorkspaceLinearSearchQuery } from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import type { parseBoundedSmartWorkspaceLinearIssueUrlIntent } from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import { RESULT_LIMIT } from './smart-workspace-name-field-model'
import { restrictJiraQueryToProject } from '../../../../shared/jira/jira-project-reference'
import { getBranchSearchRequest } from '../../../../shared/new-workspace/smart-workspace-source-results'
import type { useWorkItemSourceFoundation } from './use-work-item-source-foundation'

type Foundation = ReturnType<typeof useWorkItemSourceFoundation>

export function useSmartWorkspaceSecondarySearches({
  foundation,
  shouldQueryLinear,
  linearQuery,
  linearUrlIntent,
  linearUrlIntentOwnsInput,
  shouldQueryJira,
  jiraSearchQuery
}: {
  foundation: Foundation
  shouldQueryLinear: boolean
  linearQuery: string
  linearUrlIntent: ReturnType<typeof parseBoundedSmartWorkspaceLinearIssueUrlIntent>
  linearUrlIntentOwnsInput: boolean
  shouldQueryJira: boolean
  jiraSearchQuery: string | null
}): void {
  const {
    disabled,
    jiraSource,
    branchesEnabled,
    repoBackedSourcesDisabled,
    textOnly,
    mode,
    selectedRepo,
    debouncedQuery,
    setBranches,
    setBranchResultsSource,
    setBranchesLoading,
    linearStatus,
    linearSourceContext,
    linearWorkspaceIdOverride,
    setLinearIssues,
    setLinearLoading,
    setSettledLinearUrlQuery,
    setLinearReadError,
    jiraSourceContext,
    jiraConnectionStatus,
    jiraProject,
    searchJiraIssues,
    setJiraIssues,
    setJiraLoading
  } = foundation
  // Read the latest metadata for URL resolution without making the search effect depend on object identity.
  const linearStatusRef = useRef(linearStatus)
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  linearStatusRef.current = linearStatus
  // Store action references can change with wiring; reads should only rerun for query/scope changes.
  const linearReadMethodsRef = useRef(foundation)
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  linearReadMethodsRef.current = foundation
  const failedLinearReadRef = useRef<readonly unknown[] | null>(null)
  const linearScopeSignature = linearWorkspaceScopeSignature(linearStatus)
  const branchSearchRequest = useMemo(
    () =>
      getBranchSearchRequest({
        disabled: disabled || jiraSource.intent || linearUrlIntentOwnsInput,
        branchesEnabled: branchesEnabled && !repoBackedSourcesDisabled,
        textOnly,
        mode,
        selectedRepoId: selectedRepo?.id ?? null,
        query: debouncedQuery,
        limit: RESULT_LIMIT
      }),
    [
      branchesEnabled,
      debouncedQuery,
      disabled,
      jiraSource.intent,
      linearUrlIntentOwnsInput,
      mode,
      repoBackedSourcesDisabled,
      selectedRepo?.id,
      textOnly
    ]
  )

  // Why: branches are searched on the selected repo's own host.
  const selectedRepoHostId = selectedRepo ? getRepoExecutionHostId(selectedRepo) : null
  useEffect(() => {
    if (!branchSearchRequest || !selectedRepoHostId) {
      setBranches([])
      setBranchResultsSource(null)
      setBranchesLoading(false)
      return
    }
    let stale = false
    // Why: visibility retains prior rows while typing ahead of the debounced query.
    setBranchesLoading(true)
    void searchRuntimeRepoBaseRefDetails(
      selectedRepoHostId,
      branchSearchRequest.repoId,
      branchSearchRequest.query,
      branchSearchRequest.limit
    )
      .then((results) => {
        if (!stale) {
          setBranches(results)
          setBranchResultsSource({
            repoId: branchSearchRequest.repoId,
            query: branchSearchRequest.query
          })
        }
      })
      .catch(() => {
        if (!stale) {
          setBranches([])
          setBranchResultsSource(null)
        }
      })
      .finally(() => {
        if (!stale) {
          setBranchesLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [
    branchSearchRequest,
    selectedRepoHostId,
    setBranches,
    setBranchResultsSource,
    setBranchesLoading
  ])

  useEffect(() => {
    const readKey = [linearQuery, linearSourceContext, linearWorkspaceIdOverride] as const
    // Why: the status refresh after a failure re-runs this same read; don't blink its error.
    const rereadOfFailure =
      failedLinearReadRef.current?.every((part, index) => part === readKey[index]) === true
    const canQuery = !disabled && shouldQueryLinear && linearStatus.connected === true
    if (!rereadOfFailure || !canQuery) {
      failedLinearReadRef.current = null
      setLinearReadError(null)
    }
    if (!canQuery) {
      setLinearIssues([])
      setLinearLoading(false)
      setSettledLinearUrlQuery(null)
      return
    }
    let stale = false
    const trimmed = linearQuery.trim()
    if (!rereadOfFailure) {
      setLinearLoading(true)
      setSettledLinearUrlQuery(null)
    }
    // Why: empty-query list must not briefly paint the previous non-empty result set.
    if (trimmed === '') {
      setLinearIssues([])
    }
    const readOptions = {
      sourceContext: linearSourceContext,
      ...(linearWorkspaceIdOverride !== undefined ? { workspaceId: linearWorkspaceIdOverride } : {})
    }
    const request: LinearIssueRead<LinearIssue[] | LinearCollectionResult<LinearIssue>> =
      linearUrlIntent
        ? mapLinearIssueRead(
            lookupLinearIssueUrl({
              intent: linearUrlIntent,
              knownStatus: linearStatusRef.current,
              sourceContext: linearSourceContext,
              fetchLinearIssue: (identifier, workspaceId, options) =>
                linearReadMethodsRef.current.fetchLinearIssue(identifier, workspaceId, {
                  ...options,
                  rejectCredentialError: true
                })
            }),
            (issue) => (issue ? [issue] : [])
          )
        : trimmed
          ? linearReadMethodsRef.current.searchLinearIssues(
              getSmartWorkspaceLinearSearchQuery(trimmed),
              RESULT_LIMIT,
              readOptions
            )
          : linearReadMethodsRef.current.listLinearIssues(
              { kind: 'list', filter: 'assigned', limit: RESULT_LIMIT },
              readOptions
            )
    const release = observeLinearIssueRead(
      request,
      () => !stale,
      (lease, view) => {
        if (view.kind === 'abandoned') {
          return setLinearLoading((previous) => (!stale ? false : previous))
        }
        setLinearIssues((current) =>
          lease.commit(view, current, (_, data) =>
            data ? (Array.isArray(data) ? data : data.items) : view.kind === 'error' ? current : []
          )
        )
        if (view.kind === 'data' || view.kind === 'error') {
          failedLinearReadRef.current =
            view.kind === 'error' && isIntegrationCredentialDecryptionError(view.error)
              ? readKey
              : null
          setLinearReadError((current) =>
            lease.commit(view, current, (_, data) =>
              view.kind === 'error'
                ? linearIssueReadError(view.error)
                : data && !Array.isArray(data) && data.errors?.length
                  ? linearIssueReadError(data.errors[0].message)
                  : null
            )
          )
          setSettledLinearUrlQuery((current) =>
            lease.commit(view, current, () => (linearUrlIntent ? trimmed : null))
          )
        }
        setLinearLoading((current) => lease.commit(view, current, () => view.kind === 'loading'))
      }
    )
    return () => {
      stale = true
      release()
    }
  }, [
    disabled,
    linearStatus.connected,
    linearQuery,
    linearScopeSignature,
    linearSourceContext,
    linearWorkspaceIdOverride,
    linearUrlIntent,
    setLinearIssues,
    setLinearLoading,
    setLinearReadError,
    setSettledLinearUrlQuery,
    shouldQueryLinear
  ])

  useEffect(() => {
    if (!shouldQueryJira || !jiraSourceContext || !jiraSearchQuery) {
      setJiraIssues([])
      setJiraLoading(false)
      return
    }
    let stale = false
    // Why: a superseded query must immediately release its shared Jira request slot.
    const controller = new AbortController()
    setJiraLoading(true)
    const siteId =
      jiraProject?.siteId ??
      jiraConnectionStatus?.selectedSiteId ??
      jiraConnectionStatus?.activeSiteId ??
      null
    void searchJiraIssuesByKeyOrText(jiraSearchQuery, (jql) =>
      searchJiraIssues(
        jiraProject ? restrictJiraQueryToProject(jql, jiraProject) : jql,
        RESULT_LIMIT,
        {
          sourceContext: jiraSourceContext,
          siteId,
          signal: controller.signal
        }
      )
    )
      .then((issues) => {
        if (!stale) {
          setJiraIssues(issues)
        }
      })
      .catch(() => {
        if (!stale) {
          setJiraIssues([])
        }
      })
      .finally(() => {
        if (!stale) {
          setJiraLoading(false)
        }
      })
    return () => {
      stale = true
      controller.abort()
    }
  }, [
    jiraConnectionStatus?.activeSiteId,
    jiraConnectionStatus?.selectedSiteId,
    jiraSearchQuery,
    jiraProject,
    jiraSourceContext,
    searchJiraIssues,
    setJiraIssues,
    setJiraLoading,
    shouldQueryJira
  ])
}
