import { useEffect, useMemo, useRef, useState } from 'react'
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
  const context = model.state === 'settled' ? model.pickerContext : undefined
  const settings = context ? context.settings : useAppStore.getState().settings
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
  const executionHostId = context?.executionHostId ?? route.executionHostId
  const key = useMemo(
    () =>
      JSON.stringify([
        context?.key,
        worktreeId,
        executionHostId,
        model.state === 'settled' ? model.rows : [],
        model.state === 'settled' ? model.detection.detectedIds : [],
        settings && {
          agentDefaultArgs: settings.agentDefaultArgs,
          agentPermissionDefault: settings.agentPermissionDefault,
          agentPermissionOverrides: settings.agentPermissionOverrides,
          nativeChatSessionOptions: settings.nativeChatSessionOptions,
          nativeChatPermissionMode: settings.nativeChatPermissionMode
        }
      ]),
    [context, worktreeId, executionHostId, model, settings]
  )
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
  /* oxlint-disable react-hooks/exhaustive-deps -- The semantic key covers the rows, detection, target and defaults; object identities must not restart a batch. */
  const fallback = useMemo(
    () =>
      target?.kind === 'environment'
        ? build({}).map((entry) => ({
            ...entry,
            terminal: {},
            structured: {},
            arguments: undefined,
            defaultsPending: true
          }))
        : build(settings),
    [key]
  )
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
      entries = entries.map((entry) => ({ ...entry, defaultsPending: false }))
      publish(entries)
      const params = { worktree: `id:${worktreeId}` }
      const catalogs = agentPickerHydrationQueue(entries, () => selectedRef.current)
      const supports = agentPickerHydrationQueue(entries, () => selectedRef.current)
      const hydrate = async (kind: 'catalog' | 'support') => {
        while (!controller.signal.aborted) {
          const index = (kind === 'catalog' ? catalogs : supports)()
          if (index === undefined) {
            break
          }
          const entry = entries[index]
          if (kind === 'catalog') {
            const catalog = await callStructuredAgentSession<AgentSessionModelCatalogResult>(
              target,
              'agentSession.modelCatalog',
              { ...params, agent: entry.agent, waitForListing: true }
            ).catch(() => null)
            if (catalog) {
              entries[index] = { ...entries[index], catalog }
              publish(entries)
            }
          } else if (target.kind === 'environment' && entry.surfaces.includes('chat')) {
            const support = await callStructuredAgentSession<{
              seedOptions?: Record<string, string>
            }>(target, 'agentSession.createSupport', { ...params, agent: entry.agent }).catch(
              () => null
            )
            const { model, permissionMode, ...options } =
              parseStructuredLaunchSeedOptions(support?.seedOptions) ?? {}
            if (support?.seedOptions) {
              entries[index] = {
                ...entries[index],
                structured: {
                  ...(model ? { model } : {}),
                  options,
                  ...(isAgentChatPermissionChoice(permissionMode) ? { permissionMode } : {})
                }
              }
              publish(entries)
            }
          }
        }
      }
      await Promise.all([
        hydrate('catalog'),
        hydrate('catalog'),
        hydrate('support'),
        hydrate('support')
      ])
    })().catch(() => publish(fallback))
    return () => controller.abort()
  }, [key, open])
  /* oxlint-enable react-hooks/exhaustive-deps */
  return snapshot?.key === key ? snapshot.entries : fallback
}
