import { z } from 'zod'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import type { AgentPickerInventory } from './agent-launch-picker'
import { AGENT_PERMISSION_CHOICES } from './tui-agent-permission-choice'

const agent = z.custom<TuiAgent>(isTuiAgent)
const choice = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional()
})
const model = z.object({
  isLegacy: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
  description: z.string().optional(),
  resolvedModel: z.string().nullable().optional(),
  effortsKnown: z.literal(false).optional(),
  efforts: z.array(choice),
  defaultEffort: z.string().optional(),
  supportsFastMode: z.boolean().optional(),
  supportsAutoMode: z.boolean().optional(),
  serviceTiers: z.array(choice).optional()
})
const catalogFacts = {
  listingInProgress: z.literal(true).optional(),
  unavailable: z
    .union([
      z.object({ reason: z.literal('cliMissing') }),
      z.object({
        reason: z.literal('notSignedIn'),
        account: z.enum(['managed', 'system']).optional()
      })
    ])
    .optional()
}
const catalog = z.union([
  z.object({ origin: z.literal('unknown'), ...catalogFacts }),
  z.object({
    ...catalogFacts,
    fastModeSupport: z.object({ supported: z.boolean(), reason: z.string().optional() }).optional(),
    origin: z.enum(['live-session', 'probe']),
    models: z.array(model),
    fetchedAt: z.number(),
    listingNamesConfiguredModel: z.boolean().optional(),
    defaultHoldsInEveryWorkspace: z.literal(true).optional(),
    modelsDifferByWorkspace: z.literal(true).optional()
  })
])
const choices = z.object({
  model: z.string().optional(),
  options: z.record(z.string(), z.string()).optional(),
  permissionMode: z.enum(AGENT_PERMISSION_CHOICES).optional()
})
const row = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), agent }),
  z.object({ kind: z.literal('cli'), agent }),
  z.object({ kind: z.literal('terminal'), agent }),
  z.object({
    kind: z.literal('chat-unavailable'),
    agent,
    reason: z.enum(['check-failed', 'not-installed', 'ssh', 'wsl', 'subfolder', 'not-on-host'])
  })
])
export const agentPickerInventorySchema: z.ZodType<AgentPickerInventory> = z.object({
  worktree: z.string().optional(),
  entries: z.array(
    z.object({
      agent,
      label: z.string(),
      aliases: z.array(z.string()).optional(),
      rows: z.array(row),
      surfaces: z.array(z.enum(['chat', 'terminal'])),
      defaultSurface: z.enum(['chat', 'terminal']),
      terminal: choices,
      structured: choices,
      arguments: z.string().nullable().optional(),
      catalog
    })
  )
})
