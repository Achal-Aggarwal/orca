import { z } from 'zod'
import { isTuiAgent } from '../tui-agent-config'
import type { TuiAgent } from '../tui-agent'

export const AgentLaunchPickerInventory = z
  .object({
    worktree: z.string().min(1).max(32768).optional(),
    agent: z.custom<TuiAgent>(isTuiAgent).optional()
  })
  .strict()
