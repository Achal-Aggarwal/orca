import { translate } from '@/i18n/i18n'
import { structuredLaunchFailure } from './structured-agent-session-launch-failure'
import { agentLabel } from '../../../shared/ai-vault-session-filters'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'

export function conversationSwitchFailureText(
  error: unknown,
  args: {
    agent: AiVaultAgent
    direction: 'chat' | 'terminal'
    source?: unknown
    history?: unknown
    platform?: string
  },
  reasonOverride?: string,
  context?: { suspended: boolean }
): string {
  const failure = structuredLaunchFailure(error)
  const reason = reasonOverride ?? failure?.details?.reason
  const values = { agent: agentLabel(args.agent) }
  if (reason === 'turnActive') {
    return translate(
      'components.tab.bar.switch.replyBusy',
      '{{agent}} is replying. Wait for the reply or stop it, then switch.',
      values
    )
  }
  if (reason === 'handoffInFlight') {
    return translate(
      'components.tab.bar.switch.switchBusy',
      '{{agent}} is already switching. Wait, then try again.',
      values
    )
  }
  if (reason === 'providerStarting') {
    return translate(
      'components.tab.bar.switch.startBusy',
      '{{agent}} is starting. Wait, then switch.',
      values
    )
  }
  if (reason === 'messagesUnsettled' || reason === 'backgroundTasksRunning') {
    return translate(
      'components.tab.bar.switch.workBusy',
      '{{agent}} still has work waiting. Finish or cancel it, then switch.',
      values
    )
  }
  if (reason === 'conversationHeldElsewhere') {
    return failure?.source
      ? translate(
          'components.tab.bar.switch.sourceExitUnconfirmed',
          'Orca could not confirm {{agent}} stopped in this terminal. Quit {{agent}} here, then try this action again.',
          values
        )
      : failure?.owner
        ? translate(
            'components.tab.bar.switch.openElsewhere',
            '{{agent}} is open in another chat or terminal. Continue there, then try switching again.',
            values
          )
        : translate(
            'components.tab.bar.switch.writerUnconfirmed',
            'Orca could not confirm {{agent}} stopped. Check its open chats and terminals, then try this action again.',
            values
          )
  }
  if (reason === 'conversationOpenInTerminal') {
    const suspended =
      context?.suspended ?? (args.platform === 'darwin' || args.platform === 'linux')
    return translate(
      suspended
        ? 'components.tab.bar.switch.terminalBusyPosix'
        : 'components.tab.bar.switch.terminalBusy',
      suspended
        ? '{{agent}} cannot switch while this terminal has a running job. If you suspended a job, run fg and exit it, then switch.'
        : '{{agent}} cannot switch while this terminal has a running job. Exit the job, then switch.',
      values
    )
  }
  if (reason === 'previousExitUnverifiable') {
    return translate(
      'components.tab.bar.switch.unavailableNow',
      'Switching {{agent}} is unavailable for this chat now. You can keep using chat.',
      values
    )
  }
  if (reason === 'ownerUnproven') {
    return translate(
      'components.tab.bar.switch.stopUnknown',
      'Orca could not confirm {{agent}} stopped. Restart Orca, then check this chat before trying again. Switching may remain unavailable.',
      values
    )
  }
  if (reason === 'operationExpired' || reason === 'outcomeUnknown' || reason === 'tabUnconfirmed') {
    return translate(
      'components.tab.bar.switch.outcomeUnknown',
      'Orca could not confirm the {{agent}} switch. Check the open chat and terminal before trying again.',
      values
    )
  }
  if (reason === 'transcriptNotFound') {
    return translate(
      'components.native-chat.resumeInNewChat.notSavedYet',
      "{{agent}} hasn't saved this conversation yet. Try again after it replies.",
      values
    )
  }
  if (reason === 'transcriptUnreadable') {
    return translate(
      'components.tab.bar.switch.historyUnavailable',
      "{{agent}} couldn't open this conversation's history. Check that its saved conversation is available, then try again.",
      values
    )
  }
  return args.direction === 'chat'
    ? translate(
        'components.tab.bar.switch.chatStartFailed',
        '{{agent}} could not start in chat. Check its setup and try again.',
        values
      )
    : translate(
        'components.tab.bar.switch.terminalStartFailed',
        '{{agent}} could not start in a terminal. Check its setup and try again.',
        values
      )
}

export function conversationSwitchSourceKept(agent: AiVaultAgent): string {
  return translate(
    'components.tab.bar.switch.sourceKept',
    '{{agent}} opened successfully. The original tab was kept; continue in the new tab.',
    { agent: agentLabel(agent) }
  )
}
