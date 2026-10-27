import { useEffect, useState, useRef } from 'react'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { agentPickerInventorySchema } from '../../../src/shared/agent-launch-picker-inventory-schema'
import {
  AGENT_LAUNCH_PICKER_INVENTORY_CAPABILITY,
  agentPickerEntriesFromRows,
  agentPickerHydrationQueue,
  type AgentPickerEntry
} from '../../../src/shared/agent-launch-picker'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'
import { callAgentSession } from './mobile-structured-agent-session-rpc'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session-wire'

const inventoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent-launch.picker-inventory',
    method: 'agentLaunch.pickerInventory',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('picker-inventory', agentPickerInventorySchema)
  })
)

export function useMobileAgentPickerInventory({
  client,
  worktreeId,
  hostCapabilities,
  options,
  open,
  connectionKey,
  selected
}: {
  client: RpcClient | null
  worktreeId: string
  hostCapabilities?: readonly string[] | null
  options: MobileNewTabAgentOption[]
  open: boolean
  connectionKey?: string
  selected?: AgentPickerEntry['agent']
}): AgentPickerEntry[] {
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [snapshot, setSnapshot] = useState<{
    client: RpcClient
    key: string
    entries: AgentPickerEntry[]
  } | null>(null)
  const modern = hostCapabilities?.includes(AGENT_LAUNCH_PICKER_INVENTORY_CAPABILITY) === true
  const key = JSON.stringify([connectionKey, worktreeId, hostCapabilities, modern ? null : options])
  const fallback = agentPickerEntriesFromRows(
    options.map((option) => ({ kind: 'terminal', agent: option.agent })),
    options.map((option) => option.agent),
    (agent) =>
      options.find((option) => option.agent === agent)?.pickerSeed ?? {
        terminal: {},
        structured: {}
      },
    (agent) => options.find((option) => option.agent === agent)?.label ?? agent
  )
  useEffect(() => {
    if (!client || !open) {
      return
    }
    let stale = false
    const modern = hostCapabilities?.includes(AGENT_LAUNCH_PICKER_INVENTORY_CAPABILITY) === true
    const params = { worktree: `id:${worktreeId}` }
    const publish = (entries: AgentPickerEntry[]) => {
      if (!stale) {
        setSnapshot({ client, key, entries: [...entries] })
      }
    }
    void (async () => {
      const entries = modern
        ? inventoryRead.interpret(await inventoryRead.request(client, params)).entries
        : fallback
      publish(entries)
      const next = agentPickerHydrationQueue(entries, () => selectedRef.current)
      const hydrate = async () => {
        while (!stale) {
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
              const answer = inventoryRead.interpret(
                await inventoryRead.request(
                  client,
                  { ...params, agent: entry.agent },
                  { timeoutMs: 90_000 }
                )
              )
              const hydrated = answer.entries.find((row) => row.agent === entry.agent)
              if (hydrated) {
                entries[index] = {
                  ...hydrated,
                  rows: entry.rows,
                  surfaces: entry.surfaces,
                  defaultSurface: entry.defaultSurface
                }
              }
            } else {
              const support = await callAgentSession<{ supported?: boolean }>(
                client,
                'agentSession.createSupport',
                { ...params, agent: entry.agent }
              ).catch(() => null)
              const chat = support?.supported === true
              entries[index] = {
                ...entry,
                surfaces: chat ? ['chat', 'terminal'] : ['terminal'],
                defaultSurface:
                  chat &&
                  options.find((option) => option.agent === entry.agent)?.pickerSeed?.chatDefault
                    ? 'chat'
                    : 'terminal'
              }
              publish(entries)
              const catalog = await callAgentSession<AgentSessionModelCatalogResult>(
                client,
                'agentSession.modelCatalog',
                { ...params, agent: entry.agent, waitForListing: true },
                90_000
              )
              entries[index] = {
                ...entries[index],
                catalog
              }
            }
            publish(entries)
          } catch {
            /* Ordinary launch remains available after a catalog failure. */
          }
        }
      }
      await Promise.all([hydrate(), hydrate()])
    })().catch(() => publish(fallback))
    return () => {
      stale = true
    }
  }, [client, key, open])
  return snapshot?.client === client && snapshot.key === key ? snapshot.entries : fallback
}
