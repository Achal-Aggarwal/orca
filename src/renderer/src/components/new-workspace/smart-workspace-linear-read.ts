import { useAppStore } from '@/store'
import { getSmartWorkspaceLinearSearchQuery } from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import { RESULT_LIMIT } from './smart-workspace-name-field-model'

export function getCachedSmartWorkspaceLinearIssues(
  query: string,
  options: Parameters<ReturnType<typeof useAppStore.getState>['getCachedLinearIssues']>[1]
) {
  return useAppStore.getState().getCachedLinearIssues(
    query
      ? {
          kind: 'search',
          query: getSmartWorkspaceLinearSearchQuery(query),
          limit: RESULT_LIMIT
        }
      : { kind: 'list', filter: 'assigned', limit: RESULT_LIMIT },
    options
  )
}
