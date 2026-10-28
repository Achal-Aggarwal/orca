import type { buildNewTabAgentMenuRows } from '@/lib/new-tab-agent-menu-rows'
import type { UseDetectedAgentsResult } from '@/hooks/useDetectedAgents'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProspectiveWorkspace } from '@/lib/agent-launch-route-input'

export type NewTabAgentMenuModel =
  | { state: 'loading'; placeholderCount: number }
  | {
      state: 'settled'
      rows: ReturnType<typeof buildNewTabAgentMenuRows>
      detection: UseDetectedAgentsResult
      /** The default these rows were ordered by, so the new-agent badge marks the same agent. */
      defaultTuiAgent?: GlobalSettings['defaultTuiAgent']
      pickerContext?: {
        workspace: ProspectiveWorkspace
        executionHostId: string
        pairingRevision?: number
        runtimeId?: string | null
        settings: GlobalSettings | null
        key: string
      }
    }
