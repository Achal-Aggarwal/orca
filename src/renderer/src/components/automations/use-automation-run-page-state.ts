import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getAutomationHostTargetKey, getAutomationTargetFromHostId } from './automation-host-client'
import { canRerunAutomationRun } from './automation-run-view-state'
import { getAutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import type { AutomationsPageListState } from './use-automations-page-list-state'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageSetupState } from './use-automations-page-setup-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

/** Navigation and terminal affordances for the selected automation run. */
export function useAutomationRunPageState({
  store,
  local,
  list,
  setup
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  list: AutomationsPageListState
  setup: AutomationsPageSetupState
}) {
  const {
    pendingAutomationRunNavigation,
    setPendingAutomationRunNavigation,
    selectedId,
    setSelectedId
  } = store
  const {
    isLoading,
    automationHostTargetKey,
    automations,
    selectedAutomationRuns,
    setSelectedAutomationRunPageId,
    setActivePaneTab,
    rerunRunIdsInFlight,
    selectedExternalKey,
    selectExternalKey,
    pageView,
    setPageView,
    isDetailOpen,
    setIsDetailOpen
  } = local
  const { selected, selectedRow } = list
  const { selectedRuns, selectedAutomationRunPage } = setup

  useEffect(() => {
    if (
      !isDetailOpen ||
      pendingAutomationRunNavigation ||
      (pageView === 'run' && selectedAutomationRunPage)
    ) {
      return
    }
    const hasSelectedLocal = selectedRow?.key
      ? list.visibleRows.some((row) => row.key === selectedRow.key)
      : selectedId !== null && selectedRow !== null
    const hasSelectedExternal =
      selectedExternalKey !== null &&
      list.externalAutomationEntries.some((entry) => entry.key === selectedExternalKey)
    if (hasSelectedLocal || hasSelectedExternal) {
      return
    }
    setIsDetailOpen(false)
    setSelectedAutomationRunPageId(null)
    setActivePaneTab('overview')
  }, [
    isDetailOpen,
    pageView,
    selectedAutomationRunPage,
    list.externalAutomationEntries,
    list.visibleRows,
    pendingAutomationRunNavigation,
    selectedExternalKey,
    selectedId,
    selectedRow,
    setActivePaneTab,
    setIsDetailOpen,
    setSelectedAutomationRunPageId
  ])
  useEffect(() => {
    if (!pendingAutomationRunNavigation || isLoading) {
      return
    }
    const pending = pendingAutomationRunNavigation
    const pendingTargetKey = getAutomationHostTargetKey(
      getAutomationTargetFromHostId(pending.hostId)
    )
    if (automationHostTargetKey !== pendingTargetKey) {
      return
    }
    const pendingAutomation = automations.find(
      (automation) => automation.id === pending.automationId
    )
    if (selectedExternalKey !== null) {
      selectExternalKey(null)
    }
    if (!pendingAutomation) {
      setSelectedId(pending.automationId)
      setSelectedAutomationRunPageId(null)
      setPendingAutomationRunNavigation(null)
      if (pageView === 'run') {
        setPageView('runs')
      }
      toast.message(
        translate(
          'auto.components.automations.AutomationsPage.pendingAutomationMissing',
          'Automation no longer available.'
        )
      )
      return
    }
    if (selectedId !== pending.automationId) {
      setSelectedId(pending.automationId)
      setIsDetailOpen(true)
      return
    }
    if (!pending.runId) {
      setIsDetailOpen(true)
      setActivePaneTab('overview')
      setSelectedAutomationRunPageId(null)
      setPendingAutomationRunNavigation(null)
      setPageView('automations')
      return
    }
    if (
      selectedAutomationRuns.notice &&
      selectedAutomationRuns.automationId === pending.automationId
    ) {
      setIsDetailOpen(true)
      setActivePaneTab('runs')
      setSelectedAutomationRunPageId(null)
      setPendingAutomationRunNavigation(null)
      if (pageView === 'run') {
        setPageView('runs')
      }
      return
    }
    if (selectedAutomationRuns.automationId !== pending.automationId) {
      return
    }
    setIsDetailOpen(true)
    setActivePaneTab('runs')
    const pendingRun = selectedRuns.find((run) => run.id === pending.runId)
    if (pendingRun) {
      setSelectedAutomationRunPageId(pending.runId)
      setPendingAutomationRunNavigation(null)
      setPageView('run')
      return
    }
    setSelectedAutomationRunPageId(null)
    setPendingAutomationRunNavigation(null)
    if (pageView === 'run') {
      setPageView('runs')
    }
    toast.message(
      translate(
        'auto.components.automations.AutomationsPage.pendingAutomationRunMissing',
        'Run history no longer available.'
      )
    )
  }, [
    automations,
    automationHostTargetKey,
    isLoading,
    pendingAutomationRunNavigation,
    pageView,
    selectExternalKey,
    selectedAutomationRuns.automationId,
    selectedAutomationRuns.notice,
    selectedExternalKey,
    selectedId,
    selectedRuns,
    setActivePaneTab,
    setIsDetailOpen,
    setPendingAutomationRunNavigation,
    setPageView,
    setSelectedAutomationRunPageId,
    setSelectedId
  ])

  const selectedRunTarget = selectedAutomationRunPage
    ? list.runTargetFor(selectedAutomationRunPage)
    : null
  const selectedAutomationRunPageWorkspaceDisplay = selectedAutomationRunPage
    ? getAutomationRunWorkspaceDisplay({
        run: selectedAutomationRunPage,
        worktree: selectedRunTarget?.worktree ?? null
      })
    : null
  const selectedAutomationRunPageViewState = selectedRunTarget?.viewState ?? null
  const canRerunSelectedAutomationRunPage =
    selectedAutomationRunPage !== null &&
    canRerunAutomationRun({ automation: selected, run: selectedAutomationRunPage })
  const isSelectedAutomationRunPageRerunPending =
    selectedAutomationRunPage !== null && rerunRunIdsInFlight.has(selectedAutomationRunPage.id)

  return {
    selectedAutomationRunPageWorkspaceDisplay,
    selectedAutomationRunPageViewState,
    canRerunSelectedAutomationRunPage,
    isSelectedAutomationRunPageRerunPending
  }
}

export type AutomationRunPageState = ReturnType<typeof useAutomationRunPageState>
