import type { PermissionResult, Query } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeControlSurface } from './claude-agent-sdk-control-requests'
import { claudePlanApprovalMode, leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import type { ClaudeSession } from './structured/claude-structured-session-state'
import { invokeCanUseTool } from './claude-can-use-tool-test-support'
import {
  USER_MESSAGE,
  acquired,
  claudeFrame,
  fakeClaude
} from './claude-structured-session-test-support'

const PLAN_PROMPT = { subject: { kind: 'plan', text: '# Plan' } } as unknown as ClaudePendingPrompt
const ALLOW: PermissionResult = { behavior: 'allow', updatedInput: {}, toolUseID: 'tool-plan' }

function planSession(
  setPermissionMode: (mode: string) => Promise<void>,
  overrides: Partial<ClaudeSession> = {}
): ClaudeSession {
  return {
    connection: { setPermissionMode },
    reportedOptions: { reportedPermissionMode: 'plan' },
    launchIntent: { permissionMode: 'acceptEdits' },
    ...overrides
  } as unknown as ClaudeSession
}

describe('leaving Claude plan mode on an approved plan', () => {
  it.each([
    [{ launchIntent: { permissionMode: 'acceptEdits' } }, 'acceptEdits'],
    [{ launchIntent: { permissionMode: 'bypassPermissions' } }, 'bypassPermissions'],
    [{ launchIntent: {}, firstRootInit: { permissionMode: 'auto' } }, 'auto'],
    // The user's own CLI settings started in plan: approving still lets Claude edit, asking each time.
    [{ launchIntent: {}, firstRootInit: { permissionMode: 'plan' } }, 'default'],
    [{}, 'default']
  ])('returns to the chat’s own mode (%j)', (session, mode) => {
    expect(claudePlanApprovalMode(session as Pick<ClaudeSession, 'launchIntent'>)).toBe(mode)
  })

  it('changes nothing for Keep planning, other approvals, or a chat already out of plan', () => {
    const setPermissionMode = vi.fn(async () => {})
    const deny: PermissionResult = { behavior: 'deny', message: 'keep planning', toolUseID: 't' }
    leaveClaudePlanModeOnApproval(planSession(setPermissionMode), PLAN_PROMPT, deny)
    leaveClaudePlanModeOnApproval(planSession(setPermissionMode), {} as ClaudePendingPrompt, ALLOW)
    leaveClaudePlanModeOnApproval(
      planSession(setPermissionMode, { reportedOptions: { reportedPermissionMode: 'ask' } }),
      PLAN_PROMPT,
      ALLOW
    )
    expect(setPermissionMode).not.toHaveBeenCalled()
  })

  it('never lets a failed mode change escape into the approval', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const throwing = (): Promise<void> => {
      throw new Error('closed')
    }
    expect(() =>
      leaveClaudePlanModeOnApproval(planSession(throwing), PLAN_PROMPT, ALLOW)
    ).not.toThrow()
    leaveClaudePlanModeOnApproval(
      planSession(() => Promise.reject(new Error('rejected'))),
      PLAN_PROMPT,
      ALLOW
    )
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2))
    warn.mockRestore()
  })

  it('writes the mode request through the real control path before the allow answer', async () => {
    const order: string[] = []
    const query = {
      setPermissionMode: async (mode: string) => {
        order.push(`set_permission_mode:${mode}`)
      }
    } as unknown as Query
    let settle = (_result: PermissionResult): void => {}
    // Stands in for the SDK writing the callback's control_response once it resolves.
    const callback = new Promise<PermissionResult>((resolve) => {
      settle = resolve
    }).then((result) => order.push(`control_response:${result.behavior}`))
    const session = planSession(createClaudeControlSurface(query).setPermissionMode)

    leaveClaudePlanModeOnApproval(session, PLAN_PROMPT, ALLOW)
    settle(ALLOW)
    await callback

    expect(order).toEqual(['set_permission_mode:acceptEdits', 'control_response:allow'])
  })

  it('switches a live chat out of plan when the user approves its plan', async () => {
    const claude = fakeClaude({ replayUuid: 'turn-1' })
    const adapter = await acquired(claude)
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-turn-1',
      body: USER_MESSAGE,
      fence: 7
    })
    const connection = claude.connections[0]
    if (!connection) {
      throw new Error('expected Claude connection')
    }
    claudeFrame(connection, { type: 'system', subtype: 'status', permissionMode: 'plan' })
    const answered = invokeCanUseTool(connection, 'ExitPlanMode', 'permission-plan', 'tool-plan', {
      input: { plan: '# Add multiply\n\n- Edit math.js' }
    })
    adapter.bindPromptItemId('session-1', 'journal-plan', 'permission-plan')

    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-plan',
      kind: 'approval',
      response: { kind: 'option', optionId: 'allow' },
      fence: 7,
      commit: async () => {}
    })

    await expect(answered.promise).resolves.toMatchObject({ behavior: 'allow' })
    expect(connection.calls.filter((call) => call.subtype === 'set_permission_mode')).toEqual([
      { subtype: 'set_permission_mode', params: { mode: 'default' } }
    ])
  })
})
