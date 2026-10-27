import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { createDesktopRunTerminalLifecycle } from './desktop-run-terminal-lifecycle'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { launchAgentOnHost } from '../runtime/rpc/methods/agent-launch'
import { findReusableAutomationRun } from '../../shared/automation-session-reuse'
import { reuseAutomationChat } from './automation-chat-session-reuse'
import { buildHeadlessAutomationWorkspaceName } from './headless-workspace-create'
import type { AutomationRunTargetResult } from './run-target-resolution'
import {
  AutomationRunLaunchError,
  type HeadlessAutomationDispatchLaunch
} from './headless-dispatch'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { automationRunOperationId, AUTOMATION_AGENT_CALLER } from './automation-run-operation'
import { createAutomationDispatchToken } from './dispatch-tokens'
import { mergeExtraAgentArgs, hasExtraAgentArgs } from '../../shared/automation-extra-agent-args'
import { resolveTuiAgentLaunchArgs } from '../../shared/tui-agent-launch-defaults'
import { agentLaunchQuotingShell } from '../../shared/agent-launch-runtime'
import {
  resolveAgentLaunchRuntime,
  newWorktreeLaunchScope
} from '../runtime/agent-launch-scope-runtime'
import { rpcCallerOperationKey } from '../runtime/rpc/rpc-caller-identity'
import { tuiAgentDisplayName } from '../../shared/tui-agent-display-names'

export type HeadlessAutomationAgentLaunch = HeadlessAutomationDispatchLaunch & {
  terminalHandle: string | null
}

export type AutomationAgentLaunchRequest = {
  automation: Automation
  run: Pick<AutomationRun, 'id' | 'title' | 'scheduledFor' | 'createdAt'>
  target: Extract<AutomationRunTargetResult, { ok: true }>
  runs: readonly AutomationRun[]
}

export async function launchHeadlessAutomationAgent(
  runtime: OrcaRuntimeService,
  request: AutomationAgentLaunchRequest,
  lifecycle?: ReturnType<ReturnType<typeof createDesktopRunTerminalLifecycle>['begin']>
): Promise<HeadlessAutomationAgentLaunch> {
  try {
    return await launchAutomationAgent(runtime, request, lifecycle)
  } catch (error) {
    lifecycle?.release()
    if (error instanceof AutomationRunLaunchError) {
      throw error
    }
    console.error('[automations] agent launch failed:', error)
    throw new Error(
      `${tuiAgentDisplayName(request.automation.agentId) ?? 'The agent'} could not confirm this run's prompt. Open its workspace before running again.`
    )
  }
}

async function launchAutomationAgent(
  runtime: OrcaRuntimeService,
  request: AutomationAgentLaunchRequest,
  lifecycle?: ReturnType<ReturnType<typeof createDesktopRunTerminalLifecycle>['begin']>
): Promise<HeadlessAutomationAgentLaunch> {
  const { automation, run, target } = request
  const surface = automation.surface ?? 'terminal'
  const context = { runtime, caller: AUTOMATION_AGENT_CALLER }
  let published: HeadlessAutomationAgentLaunch | undefined
  const policy = {
    ...lifecycle?.policy,
    onSurfacePublished: (result: AgentLaunchResult) => {
      published = publishedLaunchTarget(runtime, result)
      lifecycle?.policy.onSurfacePublished?.(result)
    },
    terminalTitle: run.title,
    suppressStartupUpdatePrompt: true,
    unprovableHost: 'write-unless-shell'
  } as const
  if (
    automation.reuseSession &&
    automation.workspaceId &&
    (surface === 'chat' || !hasExtraAgentArgs(automation.extraAgentArgs))
  ) {
    if (surface === 'chat') {
      const reused = await reuseAutomationChat(runtime, request)
      if (reused) {
        return reused
      }
    } else {
      const reused = findReusableAutomationRun({
        automationId: automation.id,
        agentId: automation.agentId,
        worktreeId: automation.workspaceId,
        currentRunId: run.id,
        runs: request.runs.filter((entry) => entry.sessionKind === 'terminal'),
        agentStatusForPane: (paneKey) =>
          runtime
            .getAgentStatusRowsForPane(paneKey)
            .filter((row) => !row.providerSessionOnly)
            .toSorted((a, b) => b.receivedAt - a.receivedAt)[0],
        liveSession: (previous) => runOwnHandle(runtime, previous)
      })
      if (reused) {
        const operationId = automationRunOperationId(run, 'reuse-terminal-launch')
        try {
          const result = await launchAgentOnHost(
            {
              agent: automation.agentId,
              operationId,
              target: { kind: 'existing', worktree: `id:${automation.workspaceId}` },
              surface,
              reuseTerminal: { handle: reused },
              prompt: { text: automation.prompt, delivery: 'submit' },
              presentation: 'background'
            },
            context,
            policy
          )
          published ??= publishedLaunchTarget(runtime, result)
          if (result.prompt?.outcome === 'handed-to-terminal') {
            return launchOutcome(runtime, result)
          }
          throw new AutomationRunLaunchError(
            `${tuiAgentDisplayName(automation.agentId)} could not confirm this run's prompt. Open the terminal before running again.`,
            published
          )
        } catch (error) {
          if (published) {
            throw new AutomationRunLaunchError(
              `${tuiAgentDisplayName(automation.agentId)} could not confirm this run's prompt. Open the terminal before running again.`,
              published
            )
          }
          const records = await runtime.openAgentSessionRecordStore()
          const row = records.getOperationRow(
            rpcCallerOperationKey(AUTOMATION_AGENT_CALLER),
            operationId
          )
          // Only the launch owner's durable no-effect verdict permits a different launch.
          if (row?.outcome.status !== 'failed') {
            throw error
          }
        }
      }
    }
  }
  const operationId = automationRunOperationId(run, 'fresh-launch')
  const settings = runtime.requireStore().getSettings()
  let merged: ReturnType<typeof mergeExtraAgentArgs> | null = null
  if (surface === 'terminal' && hasExtraAgentArgs(automation.extraAgentArgs)) {
    const scope =
      automation.workspaceMode === 'existing' && automation.workspaceId
        ? await runtime.showTerminalWorkspaceLaunchScope(`id:${automation.workspaceId}`)
        : newWorktreeLaunchScope(target.repo, settings)
    merged = mergeExtraAgentArgs({
      agent: automation.agentId,
      extraAgentArgs: automation.extraAgentArgs,
      defaultArgs: resolveTuiAgentLaunchArgs(automation.agentId, settings),
      shell: agentLaunchQuotingShell(
        resolveAgentLaunchRuntime(runtime.requireStore(), scope, undefined, automation.agentId)
      )
    })
  }
  if (merged && !merged.ok) {
    throw new AutomationRunLaunchError(
      `${tuiAgentDisplayName(automation.agentId)} could not start. ${merged.error}`
    )
  }
  if (automation.workspaceMode === 'existing' && automation.workspaceId) {
    lifecycle?.reserve(automation.workspaceId)
  }
  try {
    const result = await launchAgentOnHost(
      {
        agent: automation.agentId,
        operationId,
        ...(lifecycle ? { paneKey: lifecycle.paneKey } : {}),
        surface,
        presentation: 'background',
        prompt: { text: automation.prompt, delivery: 'submit' },
        ...(merged?.ok ? { agentArgs: merged.agentArgs } : {}),
        target:
          automation.workspaceMode === 'existing'
            ? { kind: 'existing', worktree: `id:${automation.workspaceId}` }
            : {
                kind: 'create-worktree',
                create: {
                  repo: `id:${target.repo.id}`,
                  name: buildHeadlessAutomationWorkspaceName(run.title, run.scheduledFor),
                  ...(automation.baseBranch ? { baseBranch: automation.baseBranch } : {}),
                  setupDecision: automation.setupDecision ?? 'skip',
                  activate: false,
                  automationProvenanceRequest: {
                    automationId: automation.id,
                    automationRunId: run.id,
                    dispatchToken: createAutomationDispatchToken(automation.id, run.id),
                    createRequestId: operationId
                  }
                }
              }
      },
      context,
      policy
    )
    if (result.prompt?.outcome !== 'journaled' && result.prompt?.outcome !== 'handed-to-terminal') {
      throw new AutomationRunLaunchError(
        `${tuiAgentDisplayName(automation.agentId)} started, but Orca could not confirm this run's prompt. Open the run before trying again.`,
        published ?? publishedLaunchTarget(runtime, result)
      )
    }
    return launchOutcome(runtime, result)
  } catch (error) {
    if (
      error instanceof Error &&
      ('code' in error
        ? error.code === 'agent_session_operation_expired'
        : error.message.includes('agent_session_operation_expired'))
    ) {
      throw new AutomationRunLaunchError(
        `${tuiAgentDisplayName(automation.agentId)} could not start because this run waited too long. Run the automation again.`
      )
    }
    if (published && !(error instanceof AutomationRunLaunchError)) {
      throw new AutomationRunLaunchError(
        `${tuiAgentDisplayName(automation.agentId)} started, but Orca could not confirm this run's prompt. Open the run before trying again.`,
        published
      )
    }
    throw error
  }
}

export function publishedLaunchTarget(
  runtime: Pick<OrcaRuntimeService, 'getTerminalPaneKey' | 'getTerminalPtyIdForHandle'>,
  result: AgentLaunchResult
): HeadlessAutomationAgentLaunch {
  let paneKey = result.outcome.kind === 'terminal' ? (result.outcome.paneKey ?? null) : null
  let ptyId: string | null = null
  if (result.outcome.kind === 'terminal') {
    try {
      paneKey ??= runtime.getTerminalPaneKey(result.outcome.handle)
    } catch {
      /* Keep publication identity. */
    }
    try {
      ptyId = runtime.getTerminalPtyIdForHandle(result.outcome.handle)
    } catch {
      /* Process evidence is optional for opening. */
    }
  }
  return {
    workspaceId: result.worktreeId,
    workspaceDisplayName: null,
    sessionKind: result.outcome.kind === 'structured' ? 'chat' : 'terminal',
    chatSessionId: result.outcome.kind === 'structured' ? result.outcome.sessionId : null,
    terminalHandle: result.outcome.kind === 'terminal' ? result.outcome.handle : null,
    terminalSessionId: parsePaneKey(paneKey ?? '')?.tabId ?? null,
    terminalPaneKey: paneKey,
    terminalPtyId: ptyId
  }
}

async function launchOutcome(
  runtime: OrcaRuntimeService,
  result: AgentLaunchResult
): Promise<HeadlessAutomationAgentLaunch> {
  const target = publishedLaunchTarget(runtime, result)
  try {
    const shown = await runtime.showManagedWorktree(`id:${result.worktreeId}`)
    target.workspaceDisplayName = shown.displayName ?? null
  } catch {
    // Publication already owns the target; optional display metadata cannot erase it.
  }
  if (result.outcome.kind === 'terminal' && !target.terminalSessionId) {
    try {
      target.terminalSessionId = (await runtime.showTerminal(result.outcome.handle)).tabId ?? null
    } catch {
      // Keep the published pane and process identity when its presentation is unavailable.
    }
  }
  return target
}

/** A pane may have been reused by a later process. */
export function runOwnHandle(
  runtime: Pick<OrcaRuntimeService, 'getTerminalHandleForPaneKey' | 'getTerminalPtyIdForHandle'>,
  run: AutomationRun
): string | null {
  const handle = run.terminalPaneKey
    ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey)
    : null
  return handle &&
    run.terminalPtyId &&
    runtime.getTerminalPtyIdForHandle(handle) === run.terminalPtyId
    ? handle
    : null
}
