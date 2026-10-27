import { useEffect, useState, useRef } from 'react'
import { readHostAgentLaunchSettings } from '../settings/agent-launch-settings-transport'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import { useAppStore } from '@/store'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId
} from '@/lib/agent-launch-route-input'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import {
  AGENT_LAUNCH_PICKER_INVENTORY_CAPABILITY,
  agentPickerEntriesFromRows,
  agentPickerChoiceSeeds,
  agentPickerHydrationQueue,
  type AgentPickerEntry,
  type AgentPickerInventory
} from '../../../../shared/agent-launch-picker'

export function useAgentLaunchPickerInventory(
  worktreeId: string | undefined,
  model: NewTabAgentMenuModel,
  open = true,
  selected?: AgentPickerEntry['agent']
): AgentPickerEntry[] {
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const desktopSettings = useAppStore((state) => state.settings)
  const context = model.state === 'settled' ? model.pickerContext : undefined
  const settings = context?.settings ?? desktopSettings
  const [snapshot, setSnapshot] = useState<{ key: string; entries: AgentPickerEntry[] } | null>(
    null
  )
  const route = buildAgentLaunchRouteInput(useAppStore.getState(), {
    agent: 'claude',
    workspace: context?.workspace ?? {
      kind: worktreeId ? workspaceKindForWorktreeId(worktreeId) : 'git-worktree',
      ...(worktreeId ? { worktreeId } : {})
    }
  })
  const target = structuredAgentSessionTargetForHost(
    context?.executionHostId ?? route.executionHostId
  )
  const key = JSON.stringify([
    context?.key,
    worktreeId,
    target,
    route.hostCapabilities,
    model.state === 'settled' ? model.rows : [],
    settings
  ])
  const fallback =
    model.state === 'settled'
      ? agentPickerEntriesFromRows(
          model.rows,
          model.detection.detectedIds ?? [],
          (agent) => agentPickerChoiceSeeds(agent, settings),
          formatAgentTypeLabel
        )
      : []
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- The serialized key includes every scope/default input; object identities would restart the open-bound batch.
  useEffect(() => {
    if (!open || !target || model.state !== 'settled') {
      return
    }
    let cancelled = false
    const modern =
      (context?.capabilities ?? route.hostCapabilities)?.includes(
        AGENT_LAUNCH_PICKER_INVENTORY_CAPABILITY
      ) === true
    const scope = context?.workspace.worktreeId ?? worktreeId
    const params = scope ? { worktree: `id:${scope}` } : {}
    const publish = (entries: AgentPickerEntry[]) => {
      if (!cancelled) {
        setSnapshot({ key, entries: [...entries] })
      }
    }
    void (async () => {
      let legacyEntries = fallback
      if (!modern && target.kind === 'environment') {
        const hostSettings = await readHostAgentLaunchSettings({
          environmentId: target.environmentId
        }).catch(() => null)
        if (hostSettings) {
          const permission = hostSettings.agentPermission
          legacyEntries = fallback.map((entry) => ({
            ...entry,
            ...agentPickerChoiceSeeds(entry.agent, {
              agentDefaultArgs: permission?.userArgs ?? hostSettings.agentDefaultArgs,
              ...(permission
                ? {
                    agentPermissionDefault: permission.default,
                    agentPermissionOverrides: permission.overrides
                  }
                : {})
            })
          }))
        }
      }
      const inventory = modern
        ? await callRuntimeRpc<AgentPickerInventory>(target, 'agentLaunch.pickerInventory', params)
        : { entries: legacyEntries }
      if (cancelled) {
        return
      }
      const merge = (entry: AgentPickerEntry) => {
        const observed = fallback.find((row) => row.agent === entry.agent)
        return observed
          ? {
              ...entry,
              rows: observed.rows,
              surfaces: observed.surfaces,
              defaultSurface: observed.defaultSurface
            }
          : entry
      }
      const entries = modern
        ? [
            ...inventory.entries.map(merge),
            ...fallback.filter(
              (entry) => !inventory.entries.some((item) => item.agent === entry.agent)
            )
          ]
        : inventory.entries
      publish(entries)
      const next = agentPickerHydrationQueue(entries, () => selectedRef.current)
      const hydrate = async () => {
        while (!cancelled) {
          const index = next()
          if (index === undefined) {
            break
          }
          const entry = entries[index]
          if (!entry.surfaces.length) {
            continue
          }
          try {
            if (modern) {
              const answer = await callRuntimeRpc<AgentPickerInventory>(
                target,
                'agentLaunch.pickerInventory',
                { ...params, agent: entry.agent },
                { timeoutMs: 90_000 }
              )
              const hydrated = answer.entries.find((row) => row.agent === entry.agent)
              if (hydrated) {
                entries[index] = merge(hydrated)
              }
            } else {
              const catalog = await callStructuredAgentSession<AgentSessionModelCatalogResult>(
                target,
                'agentSession.modelCatalog',
                { ...params, agent: entry.agent, waitForListing: true }
              )
              entries[index] = { ...entry, catalog }
            }
            publish(entries)
          } catch {
            /* Keep the launch row and its saved choices when a catalog cannot answer. */
          }
        }
      }
      await Promise.all([hydrate(), hydrate()])
    })().catch(() => publish(fallback))
    return () => {
      cancelled = true
    }
  }, [key, open])
  return snapshot?.key === key ? snapshot.entries : fallback
}
