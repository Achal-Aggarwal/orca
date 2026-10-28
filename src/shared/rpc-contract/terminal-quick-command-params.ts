import { RpcBoolean, RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import {
  MAX_QUICK_COMMAND_ID_LENGTH,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_REPO_ID_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH,
  normalizeTerminalQuickCommands,
  supportsTerminalAgentQuickCommand
} from '../terminal-quick-commands'
import type { TerminalQuickCommand } from '../terminal-quick-command-types'

export const TerminalQuickCommandScopeUpdate = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z
    .object({
      type: z.literal('repo'),
      repoId: RpcString.max(MAX_QUICK_COMMAND_REPO_ID_LENGTH)
    })
    .strict()
])

export const TerminalQuickCommandUpdateItem = z.union([
  z
    .object({
      id: RpcString.max(MAX_QUICK_COMMAND_ID_LENGTH),
      label: RpcString.max(MAX_QUICK_COMMAND_LABEL_LENGTH),
      action: z.literal('terminal-command').optional(),
      command: RpcString.max(MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH),
      appendEnter: RpcBoolean,
      scope: TerminalQuickCommandScopeUpdate.optional()
    })
    .strict(),
  z
    .object({
      id: RpcString.max(MAX_QUICK_COMMAND_ID_LENGTH),
      label: RpcString.max(MAX_QUICK_COMMAND_LABEL_LENGTH),
      action: z.literal('agent-prompt'),
      agent: z.custom(supportsTerminalAgentQuickCommand, {
        message: 'Agent does not support prompt commands'
      }),
      // Bounded where every save lands (main's settings update), with the reason in its refusal.
      prompt: RpcString,
      scope: TerminalQuickCommandScopeUpdate.optional()
    })
    .strict()
])

export const TerminalQuickCommandsUpdate = z
  .object({
    // Mutate host-side to preserve unrelated desktop/mobile edits and avoid resending multi-megabyte lists.
    mutation: z.union([
      z
        .object({
          type: z.literal('upsert'),
          command: TerminalQuickCommandUpdateItem.transform(
            (value) => normalizeTerminalQuickCommands([value])[0]
          ).pipe(
            z.custom<TerminalQuickCommand>((value) => value !== undefined, {
              message: 'Quick command cannot be normalized'
            })
          )
        })
        .strict(),
      z
        .object({
          type: z.literal('delete'),
          id: RpcString.min(1).max(MAX_QUICK_COMMAND_ID_LENGTH)
        })
        .strict()
    ])
  })
  .strict()
