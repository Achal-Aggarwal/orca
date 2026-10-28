import { useId, useLayoutEffect, useRef, useState } from 'react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import { agentMessageDisplayText } from '../../../../shared/agent-session/agent-message-display-text'
import { NativeChatAgentMessageSenders } from './NativeChatAgentMessageSenders'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { NativeChatImageAttachments } from './NativeChatTranscriptChrome'

function heading(from: AgentMessageSource): string {
  if (from.orchestration?.message === 'task')
    return translate(
      'components.native-chat.agentMessage.taskFromCoordinator',
      'Task from your coordinator'
    )
  if (
    from.orchestration?.message === 'mail-notice' &&
    from.senders.length > 0 &&
    from.senders.every((sender) => sender.relation === 'worker')
  )
    return translate(
      'components.native-chat.agentMessage.updateFromWorker',
      'Update from your worker'
    )
  return translate('components.native-chat.agentMessage.messageFrom', 'Message from')
}

export function NativeChatAgentMessageCard({
  message,
  from,
  runtimeContext,
  onLinkClick,
  allowFileUriLinks,
  onRefolded
}: {
  message: NativeChatMessage
  from: AgentMessageSource
  runtimeContext?: RuntimeFileOperationArgs | null
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks: boolean
  onRefolded: () => void
}): React.JSX.Element {
  const owner = useNativeChatVisualOwner()
  const worktreeId = owner?.worktreeId ?? runtimeContext?.worktreeId ?? null
  const view = useAgentMessageSenderView(from.senders[0], worktreeId, owner?.target)
  const text = agentMessageDisplayText(message.blocks, from)
  const disclosure = useNativeChatDisclosure(`agent-message:${message.id}`, false)
  const clip = useRef<HTMLDivElement>(null)
  const clipId = useId()
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const element = clip.current
    if (!element) return
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
      setOverflows(element.scrollHeight > lineHeight * 3 + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  return (
    <div className="flex w-full gap-3 rounded-xl border border-border bg-card p-3 text-sm text-card-foreground">
      <div className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center">
        <AgentTypeIcon agentType={view.agentType} size={24} />
        {view.dot ? (
          <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-card ring-2 ring-card">
            <AgentStateDot state={view.dot} size="md" />
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{heading(from)}</span>
          <NativeChatMessageTimestamp
            timestamp={message.timestamp}
            className="text-muted-foreground"
          />
        </div>
        <NativeChatAgentMessageSenders from={from} chatWorktreeId={worktreeId} />
        <NativeChatImageAttachments
          blocks={message.blocks}
          runtimeContext={runtimeContext}
          enablePreview={runtimeContext !== undefined}
        />
        <div
          ref={clip}
          id={clipId}
          className="overflow-hidden leading-6"
          style={disclosure.open ? undefined : { maxHeight: '3lh' }}
        >
          <NativeChatMarkdown
            rowKey={message.id}
            content={text}
            variant="document"
            className="text-sm"
            renderCodeBlock={NativeChatCodeBlock}
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
          />
        </div>
        <div className="flex items-center justify-between">
          {overflows ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-expanded={disclosure.open}
              aria-controls={clipId}
              onClick={() => {
                disclosure.setOpen(!disclosure.open)
                if (disclosure.open) requestAnimationFrame(onRefolded)
              }}
            >
              {disclosure.open
                ? translate('components.native-chat.userMessage.showLess', 'Show less')
                : translate('components.native-chat.agentMessage.showMore', 'Show more')}
            </Button>
          ) : (
            <span />
          )}
          {text ? <NativeChatCopyButton text={text} /> : null}
        </div>
      </div>
    </div>
  )
}
