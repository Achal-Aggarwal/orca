import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  AutomationAgentLaunchRequest,
  HeadlessAutomationAgentLaunch
} from './headless-automation-agent-launch'
import { automationRunRecency } from '../../shared/automation-session-reuse'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { AUTOMATION_AGENT_CALLER, automationRunOperationId } from './automation-run-operation'
import { rpcCallerOperationKey } from '../runtime/rpc/rpc-caller-identity'
import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../shared/structured-agent-session-send-mutation'
import { tuiAgentDisplayName } from '../../shared/tui-agent-display-names'

export async function reuseAutomationChat(
  runtime: OrcaRuntimeService,
  { automation, run, runs }: AutomationAgentLaunchRequest
): Promise<HeadlessAutomationAgentLaunch | null> {
  await runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  const store = await runtime.openAgentSessionRecordStore()
  const seen = new Set<string>()
  for (const previous of runs
    .filter((entry) => entry.automationId === automation.id && entry.id !== run.id)
    .toSorted((a, b) => automationRunRecency(b) - automationRunRecency(a))) {
    const id = previous.chatSessionId
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    if (
      previous.sessionKind !== 'chat' ||
      previous.status !== 'completed' ||
      previous.workspaceId !== automation.workspaceId
    ) {
      continue
    }
    const record = store.getConversation(id)
    if (
      !record ||
      record.provider !== automation.agentId ||
      record.location.workspaceId !== automation.workspaceId
    ) {
      continue
    }
    await host.journalSnapshot(id)
    const current = store.getConversation(id)
    const work = host.currentWork(id)
    if (!current || !work || work.working()) {
      continue
    }
    const sent = await host.send(
      { callerKey: rpcCallerOperationKey(AUTOMATION_AGENT_CALLER) },
      structuredAgentSessionMessageSendMutation({
        sessionId: id,
        clientOperationId: automationRunOperationId(run, 'reuse-send'),
        expectedRuntimeFence: current.currentFence,
        delivery: 'queue-if-active',
        body: structuredAgentSessionSendBody(automation.prompt, [])
      })
    )
    if (!sent.ok) {
      const row = store.getOperationRow(
        rpcCallerOperationKey(AUTOMATION_AGENT_CALLER),
        automationRunOperationId(run, 'reuse-send')
      )
      if (sent.refusal.code === 'agent_session_conflict' || row?.outcome.status === 'failed') {
        return null
      }
      throw new Error(
        `${tuiAgentDisplayName(automation.agentId)} could not accept this automation run. Open the chat and try again.`
      )
    }
    const shown = await runtime.showManagedWorktree(`id:${automation.workspaceId}`)
    return {
      workspaceId: automation.workspaceId!,
      workspaceDisplayName: shown.displayName ?? null,
      sessionKind: 'chat',
      chatSessionId: id,
      terminalHandle: null,
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    }
  }
  return null
}
