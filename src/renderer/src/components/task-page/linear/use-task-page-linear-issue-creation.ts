import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { observeLinearIssueRead } from '@/store/slices/linear/linear-issue-publication'
import type { TaskPageLinearProjectCreationModel } from './use-task-page-linear-project-creation'
import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { linearCreateIssue } from '@/runtime/runtime-linear-issue-mutations'
import { useAppStore } from '@/store'
import { defaultScopeSource } from '@/lib/default-creation-host'
export function useTaskPageLinearIssueCreation(model: TaskPageLinearProjectCreationModel) {
  const {
    settings,
    providerRuntimeContextKey,
    providerRuntimeContextKeyRef,
    linearTaskSourceContext,
    setSelectedLinearIssue,
    setLinearRefreshNonce,
    selectedLinearProject,
    setNewLinearIssueOpen,
    newLinearIssueTitle,
    setNewLinearIssueTitle,
    newLinearIssueBody,
    setNewLinearIssueBody,
    newLinearIssueSubmitting,
    setNewLinearIssueSubmitting,
    newLinearIssueStateId,
    setNewLinearIssueStateId,
    newLinearIssueAssigneeId,
    setNewLinearIssueAssigneeId,
    newLinearIssuePriority,
    setNewLinearIssuePriority,
    newLinearIssueProjectId,
    setNewLinearIssueProjectId,
    newLinearIssueLabelIds,
    setNewLinearIssueLabelIds,
    discardNewLinearIssueDraft,
    newLinearIssueTargetTeam
  } = model
  const publication = useRef<(() => void) | null>(null)
  const selection = useRef(model.linearSelectionRequest)
  const sourceKey = getLinearSourceScope(
    linearTaskSourceContext ?? defaultScopeSource(settings)
  ).contextKey
  const source = useRef(sourceKey)
  selection.current = model.linearSelectionRequest
  source.current = sourceKey
  useEffect(
    () => () => {
      publication.current?.()
      publication.current = null
    },
    [model.linearSelectionRequest, sourceKey]
  )
  const handleCreateNewLinearIssue = useCallback(async (): Promise<void> => {
    if (!newLinearIssueTargetTeam) {
      return
    }
    const title = newLinearIssueTitle.trim()
    if (!title || newLinearIssueSubmitting) {
      return
    }
    if (
      selectedLinearProject &&
      newLinearIssueProjectId === selectedLinearProject.id &&
      newLinearIssueTargetTeam.workspaceId !== selectedLinearProject.workspaceId
    ) {
      toast.error(
        translate(
          'auto.components.TaskPage.1e1b2ad8f2',
          'Select a team from the project workspace before filing this issue.'
        )
      )
      return
    }
    setNewLinearIssueSubmitting(true)
    const submitProviderRuntimeContextKey = providerRuntimeContextKey
    const initialSelection = selection.current
    publication.current?.()
    try {
      const result = await linearCreateIssue(
        linearTaskSourceContext ?? defaultScopeSource(settings),
        {
          teamId: newLinearIssueTargetTeam.id,
          title,
          description: newLinearIssueBody || undefined,
          workspaceId: newLinearIssueTargetTeam.workspaceId,
          stateId: newLinearIssueStateId || undefined,
          priority: newLinearIssuePriority,
          assigneeId: newLinearIssueAssigneeId || undefined,
          projectId: newLinearIssueProjectId || null,
          labelIds: newLinearIssueLabelIds.length > 0 ? newLinearIssueLabelIds : undefined
        }
      )
      if (submitProviderRuntimeContextKey !== providerRuntimeContextKeyRef.current) {
        return
      }
      if (!result.ok) {
        toast.error(
          result.error ||
            translate('auto.components.TaskPage.7437e340b4', 'Failed to create issue.')
        )
        return
      }
      toast.success(
        translate('auto.components.TaskPage.cb98f0350c', 'Created {{value0}}', {
          value0: result.identifier
        }),
        {
          action: result.url
            ? {
                label: translate('auto.components.TaskPage.9c57663908', 'View'),
                onClick: () => window.open(result.url, '_blank')
              }
            : undefined
        }
      )
      discardNewLinearIssueDraft()
      setNewLinearIssueOpen(false)
      setNewLinearIssueTitle('')
      setNewLinearIssueBody('')
      setNewLinearIssueStateId(null)
      setNewLinearIssueAssigneeId(null)
      setNewLinearIssuePriority(0)
      setNewLinearIssueProjectId(null)
      setNewLinearIssueLabelIds([])
      setLinearRefreshNonce((n) => n + 1)
      useAppStore.getState().recordFeatureInteraction('linear-tasks')

      publication.current = observeLinearIssueRead(
        useAppStore.getState().fetchLinearIssue(result.id, newLinearIssueTargetTeam.workspaceId, {
          scope: getLinearSourceScope(linearTaskSourceContext ?? defaultScopeSource(settings)),
          force: true
        }),
        () =>
          submitProviderRuntimeContextKey === providerRuntimeContextKeyRef.current &&
          source.current === sourceKey &&
          selection.current === initialSelection,
        (lease, view) => {
          if (view.kind === 'data' && view.data) {
            setSelectedLinearIssue(view.data, {
              allowOutsideList: true,
              expectedSelection: initialSelection,
              isCurrent: () => lease.commit(view, false, () => true)
            })
          }
        }
      )
    } finally {
      if (submitProviderRuntimeContextKey === providerRuntimeContextKeyRef.current) {
        setNewLinearIssueSubmitting(false)
      }
    }
  }, [
    newLinearIssueBody,
    newLinearIssueSubmitting,
    newLinearIssueTargetTeam,
    newLinearIssueTitle,
    newLinearIssueStateId,
    newLinearIssuePriority,
    newLinearIssueAssigneeId,
    newLinearIssueProjectId,
    newLinearIssueLabelIds,
    providerRuntimeContextKey,
    selectedLinearProject,
    setSelectedLinearIssue,
    linearTaskSourceContext,
    settings,
    sourceKey,
    discardNewLinearIssueDraft,
    setNewLinearIssuePriority,
    setNewLinearIssueBody,
    providerRuntimeContextKeyRef,
    setNewLinearIssueAssigneeId,
    setNewLinearIssueProjectId,
    setNewLinearIssueOpen,
    setNewLinearIssueLabelIds,
    setNewLinearIssueTitle,
    setNewLinearIssueStateId,
    setNewLinearIssueSubmitting,
    setLinearRefreshNonce
  ])
  const nextModel = model as typeof model & {
    handleCreateNewLinearIssue: typeof handleCreateNewLinearIssue
  }
  nextModel.handleCreateNewLinearIssue = handleCreateNewLinearIssue
  return nextModel
}
export type TaskPageLinearIssueCreationModel = ReturnType<typeof useTaskPageLinearIssueCreation>
