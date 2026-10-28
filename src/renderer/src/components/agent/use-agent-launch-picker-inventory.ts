import { useEffect, useRef, useState } from 'react'
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
import { parseStructuredLaunchSeedOptions } from '../../../../shared/native-chat-session-option-defaults'
import { isAgentChatPermissionChoice } from '../../../../shared/agent-chat-permission-mode'
import {
  agentPickerEntriesFromRows,
  agentPickerChoiceSeeds,
  agentPickerHydrationQueue,
  type AgentPickerDefaultSettings,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

export function useAgentLaunchPickerInventory(
  worktreeId: string | undefined,
  model: NewTabAgentMenuModel,
  open: boolean,
  selected?: AgentPickerEntry['agent']
): AgentPickerEntry[] {
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const desktopSettings = useAppStore((state) => state.settings)
  const context = model.state === 'settled' ? model.pickerContext : undefined
  const settings = context?.settings ?? desktopSettings
  const route = buildAgentLaunchRouteInput(useAppStore.getState(), {
    agent: 'claude',
    workspace: context?.workspace ?? {
      kind: worktreeId ? workspaceKindForWorktreeId(worktreeId) : 'floating',
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
    model.state === 'settled' ? model.rows : [],
    settings && {
      agentDefaultArgs: settings.agentDefaultArgs,
      agentPermissionDefault: settings.agentPermissionDefault,
      agentPermissionOverrides: settings.agentPermissionOverrides,
      nativeChatSessionOptions: settings.nativeChatSessionOptions,
      nativeChatPermissionMode: settings.nativeChatPermissionMode
    }
  ])
  const [snapshot, setSnapshot] = useState<{ key: string; entries: AgentPickerEntry[] } | null>(
    null
  )
  const build = (defaults: AgentPickerDefaultSettings | null | undefined) =>
    model.state === 'settled'
      ? agentPickerEntriesFromRows(
          model.rows,
          model.detection.detectedIds ?? [],
          (agent) => agentPickerChoiceSeeds(agent, defaults),
          formatAgentTypeLabel
        )
      : []
  const fallback =
    target?.kind === 'environment'
      ? build({}).map((entry) => ({
          ...entry,
          terminal: {},
          structured: {},
          arguments: undefined,
          defaultsPending: true
        }))
      : build(settings)
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- The key includes all host, workspace, account and default inputs; fresh object identities must not restart the open batch.
  useEffect(() => {
    if (!open || !target || !worktreeId || model.state !== 'settled') {
      return
    }
    const controller = new AbortController()
    const publish = (entries: AgentPickerEntry[]) => {
      if (!controller.signal.aborted) {
        setSnapshot({ key, entries: [...entries] })
      }
    }
    void (async () => {
      let entries = fallback
      if (target.kind === 'environment') {
        const host = await readHostAgentLaunchSettings(
          {
            environmentId: target.environmentId,
            pairingRevision: context?.pairingRevision,
            ...(context?.runtimeId ? { runtimeId: context.runtimeId } : {})
          },
          controller.signal
        ).catch(() => null)
        if (host) {
          const permission = host.agentPermission
          entries = build({
            agentDefaultArgs: permission?.userArgs ?? host.agentDefaultArgs,
            ...(permission
              ? {
                  agentPermissionDefault: permission.default,
                  agentPermissionOverrides: permission.overrides
                }
              : {})
          })
        } else if (!controller.signal.aborted) {
          const legacy = await callRuntimeRpc<{ settings: AgentPickerDefaultSettings }>(
            target,
            'settings.get',
            undefined,
            {
              signal: controller.signal,
              timeoutMs: 15_000,
              expectedEnvironmentPairingRevision: context?.pairingRevision,
              ...(context?.runtimeId ? { expectedEnvironmentRuntimeId: context.runtimeId } : {})
            }
          ).catch(() => null)
          if (legacy) {
            entries = build(legacy.settings)
          }
        }
      }
      if (controller.signal.aborted) {
        return
      }
      if (target.kind === 'environment') {
        entries = entries.map((entry) =>
          entry.surfaces.includes('chat') ? { ...entry, defaultsPending: true } : entry
        )
      }
      publish(entries)
      const params = { worktree: `id:${worktreeId}` }
      const next = agentPickerHydrationQueue(entries, () => selectedRef.current)
      const hydrate = async () => {
        while (!controller.signal.aborted) {
          const index = next()
          if (index === undefined) {
            break
          }
          const entry = entries[index]
          const [catalog, support] = await Promise.all([
            callStructuredAgentSession<AgentSessionModelCatalogResult>(
              target,
              'agentSession.modelCatalog',
              { ...params, agent: entry.agent, waitForListing: true }
            ).catch(() => null),
            target.kind === 'environment' && entry.surfaces.includes('chat')
              ? callStructuredAgentSession<{ seedOptions?: Record<string, string> }>(
                  target,
                  'agentSession.createSupport',
                  { ...params, agent: entry.agent }
                ).catch(() => null)
              : null
          ])
          const { model, permissionMode, ...options } =
            parseStructuredLaunchSeedOptions(support?.seedOptions) ?? {}
          entries[index] = {
            ...entry,
            ...(catalog ? { catalog } : {}),
            ...(support
              ? {
                  defaultsPending: false,
                  structured: {
                    ...(model ? { model } : {}),
                    options,
                    ...(isAgentChatPermissionChoice(permissionMode) ? { permissionMode } : {})
                  }
                }
              : {})
          }
          publish(entries)
        }
      }
      await Promise.all([hydrate(), hydrate()])
    })().catch(() => publish(fallback))
    return () => controller.abort()
  }, [key, open])
  return snapshot?.key === key ? snapshot.entries : fallback
}
