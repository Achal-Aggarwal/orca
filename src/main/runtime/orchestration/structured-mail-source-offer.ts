import { structuredMailBody } from './structured-mail-source'
import { mailSourceIncarnation } from './db/messages/mail-source-order'
import { readSourceCreation } from './structured-mail-creation-history'
import {
  messageTypeHasOrchestrationWaiter,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import {
  sourceIdentity,
  SOURCE_COLUMNS,
  type Interest,
  type SourceIdentity,
  type Debt
} from './structured-mail-source-discovery'
import {
  ordinaryMailCreationId,
  type MailDeliveryDependencies
} from './structured-mailbox-pointer-delivery'
export class MailSourceSuperseded extends Error {}

/** One candidate's ordinary creation/stamp; no execution or independently owned permission. */
export async function offerMailSource<T extends OrchestrationMessageWaiter>(input: {
  mailbox: string
  interest: Interest
  source: SourceIdentity
  deps: MailDeliveryDependencies<T>
  current: () => boolean
  retire: (id: string) => void
}): Promise<void> {
  const { mailbox, interest, source, deps, current, retire } = input
  const checkOwns = (source: SourceIdentity) => {
    return (
      messageTypeHasOrchestrationWaiter(deps.getMessageWaiters(mailbox), source.type) ||
      Boolean(deps.getDb()?.getOutstandingMailboxDelivery(mailbox)?.messageIds.includes(source.id))
    )
  }
  if (!current()) {
    return
  }
  const defer = (reason: Debt) =>
    interest.deferred.set(source.id, { sequence: source.sequence, reason })
  try {
    const receipt = readSourceCreation(deps.host, interest, source)
    if (receipt === 'accepted') {
      defer('stamp')
      interest.db.markAsDelivered([source.id], mailbox)
      retire(source.id)
      return
    }
    if (
      source.delivered_at !== null ||
      source.to_handle !== mailbox ||
      source.delivery_contract !== 'current_delivery'
    ) {
      retire(source.id)
      return
    }
    if (receipt === 'unknown') {
      defer('unknown')
      deps.onRetain?.({
        mailboxHandle: mailbox,
        sessionId: interest.target.sessionId,
        reason: 'original creation domain unknown'
      })
      return
    }
    if (source.read !== 0) {
      retire(source.id)
      return
    }
    if (checkOwns(source) || source.pointer_enter_pending !== 0) {
      defer('check')
      return
    }
    const fence = deps.host.currentFence(interest.target.sessionId)
    if (fence === null) {
      defer('retry')
      return
    }
    const message = interest.db.getMessageById(source.id)
    if (!message) {
      retire(source.id)
      return
    }
    const operationId = ordinaryMailCreationId(source)
    const body = structuredMailBody({
      ...deps,
      db: interest.db,
      mailboxHandle: mailbox,
      dispatchId: interest.target.dispatchId,
      message,
      cliCommand: deps.getCliCommand()
    })
    const result = await deps.host.send({
      ...interest.target,
      operationId,
      expectedRuntimeFence: fence,
      body,
      mailSource: {
        incarnation: mailSourceIncarnation(interest.db.db),
        sequence: source.sequence,
        origin: source.ordering_origin
      },
      beforeRun: () => {
        const raw = interest.db.db
          .prepare(`SELECT ${SOURCE_COLUMNS} FROM messages WHERE id = ?`)
          .get(source.id)
        const latest = raw && sourceIdentity.parse(raw)
        if (
          !current() ||
          !latest ||
          latest.read !== 0 ||
          latest.delivered_at !== null ||
          latest.to_handle !== mailbox ||
          latest.delivery_contract !== 'current_delivery' ||
          latest.pointer_enter_pending !== 0 ||
          checkOwns(latest)
        ) {
          throw new MailSourceSuperseded()
        }
      }
    })
    if (!current()) {
      interest.pending = true
      return
    }
    if (
      result.kind === 'queued' ||
      deps.host.readCreation(operationId, interest.target.sessionId) === 'accepted'
    ) {
      defer('stamp')
      interest.db.markAsDelivered([source.id], mailbox)
      retire(source.id)
    } else {
      defer(
        result.kind === 'capacity'
          ? 'capacity'
          : result.kind === 'retry' || result.kind === 'unattached'
            ? 'retry'
            : 'stable'
      )
      if (result.kind === 'retry') {
        deps.scheduleRetry?.(mailbox)
      }
    }
  } catch (error) {
    if (error instanceof MailSourceSuperseded) {
      if (!current()) {
        interest.pending = true
        return
      }
      const latest = interest.db.getMessageById(source.id)
      if (
        !latest ||
        latest.read !== 0 ||
        latest.delivered_at !== null ||
        latest.to_handle !== mailbox ||
        latest.delivery_contract !== 'current_delivery'
      ) {
        retire(source.id)
      } else if (checkOwns(latest) || latest.pointer_enter_pending !== 0) {
        defer('check')
      } else {
        defer('retry')
        deps.scheduleRetry?.(mailbox)
      }
      return
    }
    defer('retry')
    interest.retry = true
    deps.scheduleRetry?.(mailbox)
    console.warn('[orchestration] unfinished ordinary mail phase', {
      mailbox,
      id: source.id,
      error
    })
  }
}
