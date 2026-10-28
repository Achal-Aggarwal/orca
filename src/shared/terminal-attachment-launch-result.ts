import {
  ScalarFiniteNumber,
  ScalarNonemptyString,
  ScalarOptionalNonemptyString
} from './scalar-value-schemas'
import { z } from 'zod'
import type { SleepingAgentLaunchConfig, TerminalLaunchResult } from './agent-session-resume'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { ResumeProviderSessionParam } from './rpc-contract/terminal-unary-params'
import { sleepingAgentLaunchConfigBaseSchema } from './workspace-session-sleeping-agents'

/** A launch recipe for a pane the window was not shown; the reveal otherwise carries it. */
export type PaneLaunchRecipe = Pick<TerminalLaunchResult, 'launchToken' | 'launchAgent'> & {
  tabId: string
  leafId: string
  launchConfig: SleepingAgentLaunchConfig
}

export type TerminalAttachmentLaunchResult = TerminalLaunchResult & {
  ptyId: string
  incarnationId: string
}

const launchResultSchema = z.object({
  ptyId: ScalarNonemptyString,
  incarnationId: ScalarNonemptyString,
  savedResumeDecision: z
    .object({
      agent: ScalarNonemptyString,
      providerSession: ResumeProviderSessionParam,
      verdict: z.enum(['admitted', 'chat-home', 'chat-writing', 'unverifiable'])
    })
    .optional(),
  agentResumeUnavailable: z.literal(true).optional(),
  agentResumeRefused: z.enum(['chat-home', 'chat-writing', 'unverifiable']).optional(),
  refusedResume: z
    .object({
      agent: ScalarNonemptyString,
      providerSession: ResumeProviderSessionParam,
      expectedStatus: z
        .object({
          paneKey: ScalarNonemptyString,
          receivedAt: ScalarFiniteNumber,
          stateStartedAt: ScalarFiniteNumber
        })
        .optional(),
      expectedSavedRecord: z
        .object({
          paneKey: ScalarNonemptyString,
          capturedAt: ScalarFiniteNumber,
          updatedAt: ScalarFiniteNumber
        })
        .optional()
    })
    .optional(),
  launchConfig: sleepingAgentLaunchConfigBaseSchema.optional(),
  launchAgent: z.custom<TuiAgent>(isTuiAgent).optional(),
  launchToken: ScalarOptionalNonemptyString,
  resumeProviderSession: ResumeProviderSessionParam.optional()
})

export function parseTerminalAttachmentLaunchResult(
  value: unknown
): TerminalAttachmentLaunchResult | undefined {
  const result = launchResultSchema.safeParse(value)
  return result.success ? result.data : undefined
}
