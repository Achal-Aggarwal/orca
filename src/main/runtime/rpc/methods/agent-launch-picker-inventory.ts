import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { attachAgentModelCatalogPersistenceOnce } from '../../structured-agent-model-catalog-wiring'
import { readAgentPickerSavedCatalog } from '../../agent-launch-picker-saved-catalog'
import { agentPickerChoiceSeeds } from '../../../../shared/agent-launch-picker'
import type { AgentSessionAgentAvailability } from '../../../../shared/agent-session-agent-availability'
import { defineMethod } from '../core'
import { AgentLaunchPickerInventory } from '../../../../shared/rpc-contract/agent-launch-picker-params'
import type { AgentPickerInventory, AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import { buildNewTabAgentMenuRows } from '../../../../shared/agent-launch-picker-rows'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { detectAgentsOnHost } from '../../../preflight/workspace-agent-detection'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../../structured-agent-runtime-metadata'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { clientReadsStructuredSessionAgent } from './structured-agent-session-policy'

export const AGENT_LAUNCH_PICKER_METHODS = [
  defineMethod({
    name: 'agentLaunch.pickerInventory',
    permission: 'workspace',
    params: AgentLaunchPickerInventory,
    handler: async ({ worktree, agent }, ctx): Promise<AgentPickerInventory> => {
      const { runtime } = ctx
      const settings = runtime.requireStore().getSettings()
      const host = await runtime.resolveAgentDetectionHost(worktree)
      const detected =
        agent === undefined ? (await detectAgentsOnHost(host)).filter(isTuiAgent) : []
      const availability =
        agent === undefined && host.kind !== 'ssh'
          ? await new Promise<readonly AgentSessionAgentAvailability[]>((resolve) => {
              let release = () => {}
              let received = false
              release = runtime.subscribeStructuredAgentAvailability((rows) => {
                received = true
                resolve(rows)
                release()
              })
              if (received) {
                release()
              }
            })
          : []
      const registered = STRUCTURED_AGENT_RUNTIME_METADATA.map(({ definition }) => definition.agent)
        .filter(isTuiAgent)
        .filter((id) => clientReadsStructuredSessionAgent(ctx, id))
        .filter((id) => agent === undefined || id === agent)
      const supports = new Map(
        await Promise.all(
          registered.map(async (id) => {
            const support =
              agent === undefined && worktree
                ? await runtime
                    .getStructuredAgentSessionCreateSupport(worktree, id)
                    .catch(() => null)
                : {
                    supported: availability.some(
                      (row) => row.agent === id && row.state !== 'refused'
                    )
                  }
            return [id, support] as const
          })
        )
      )
      const rows = buildNewTabAgentMenuRows({
        settings,
        detectedOnHost: detected,
        chatAgents: registered,
        chatProgram: (id) => availability.find((row) => row.agent === id)?.chatProgram ?? 'unknown',
        hostChatAnswer: (id) =>
          host.kind === 'ssh' ? 'ssh' : supports.get(id)?.supported ? 'yes' : 'not-on-host'
      })
      const ids = agent === undefined ? [...new Set(rows.map((row) => row.agent))] : [agent]
      const catalogOwner = getStructuredAgentSessionHost()?.deps.modelCatalog
      if (!catalogOwner) {
        await attachAgentModelCatalogPersistenceOnce(getProfileUserDataPath())
      }
      const workspacePath = worktree
        ? await runtime.resolveStructuredAgentSessionLocalWorkspacePath(worktree).catch(() => null)
        : undefined
      const entries = await Promise.all(
        ids.map(async (id): Promise<AgentPickerEntry> => {
          const ownRows = rows.filter((row) => row.agent === id)
          const surfaces: AgentPickerEntry['surfaces'] = []
          if (
            supports.get(id)?.supported &&
            (ownRows.some((row) => row.kind === 'chat') ||
              availability.some(
                (row) =>
                  row.agent === id &&
                  ['available', 'installable'].includes(row.chatProgram ?? 'unknown')
              ))
          ) {
            surfaces.push('chat')
          }
          if (detected.includes(id)) {
            surfaces.push('terminal')
          }
          return {
            agent: id,
            label: formatAgentTypeLabel(id),
            rows: ownRows,
            surfaces,
            defaultSurface: ownRows.some((row) => row.kind === 'chat') ? 'chat' : 'terminal',
            ...agentPickerChoiceSeeds(id, settings),
            catalog:
              registered.includes(id) &&
              host.kind !== 'ssh' &&
              workspacePath !== null &&
              catalogOwner
                ? await catalogOwner
                    .read({
                      agent: id,
                      workspacePath,
                      ...(agent === undefined ? { savedOnly: true } : { waitForListing: true })
                    })
                    .catch(() => ({ origin: 'unknown' as const }))
                : registered.includes(id) && host.kind === 'local' && workspacePath !== null
                  ? await readAgentPickerSavedCatalog(id, () =>
                      runtime.resolveStructuredAgentAccountHome(id)
                    )
                  : { origin: 'unknown' }
          }
        })
      )
      return { ...(worktree ? { worktree } : {}), entries }
    }
  })
]
