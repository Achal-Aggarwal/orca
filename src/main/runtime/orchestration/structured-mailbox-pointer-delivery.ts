import type { OrchestrationDb } from './db'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { MailDeliveryDependencies } from './structured-mail-creation-contract'
export { ordinaryMailCreationId } from './structured-mail-creation-contract'
export type {
  StructuredPointerTarget,
  StructuredPointerSendOutcome,
  StructuredMailboxPointerHost,
  MailDeliveryDependencies
} from './structured-mail-creation-contract'
import { offerMailSource } from './structured-mail-source-offer'
import { discoverMailSources, MailDebts, type Interest } from './structured-mail-source-discovery'
export type { MailAdmission } from './structured-mail-source-discovery'
/** Disposable finite discovery only; the ordinary queue is the sole executor. */
export class OrchestrationStructuredMailboxPointerDelivery<T extends OrchestrationMessageWaiter> {
  private readonly interests = new Map<string, Interest>()
  private unsubscribe: (() => void) | undefined
  private readonly dirty = new Map<string, Set<string>>()
  private sourceDb: OrchestrationDb | null = null
  constructor(private readonly deps: MailDeliveryDependencies<T>) {
    const db = deps.getDb()
    if (db) {
      this.attachDatabase(db)
    }
  }

  attachDatabase(db: OrchestrationDb): void {
    if (this.sourceDb === db) {
      return
    }
    this.resetForDatabaseChange()
    this.sourceDb = db
    this.unsubscribe = db.mailSourceMutations.subscribe(
      (mutations) => {
        if (this.sourceDb !== db || this.deps.getDb() !== db) {
          return
        }
        const wake = new Set<string>()
        for (const mutation of mutations) {
          const classified =
            mutation.mailbox && this.interests.get(mutation.mailbox)?.deferred.get(mutation.id)
          if (!mutation.forced && classified && classified.state === mutation.state) {
            continue
          }
          for (const mailbox of new Set([
            ...mutation.previousMailboxes,
            mutation.previousMailbox,
            mutation.mailbox
          ])) {
            if (!mailbox) {
              continue
            }
            const ids = this.dirty.get(mailbox) ?? new Set<string>()
            this.dirty.set(mailbox, ids)
            ids.add(mutation.id)
            wake.add(mailbox)
          }
        }
        for (const mailbox of wake) {
          this.deliverForHandle(mailbox)
        }
      },
      (mailboxes) => {
        if (this.sourceDb !== db || this.deps.getDb() !== db) {
          return
        }
        for (const mailbox of mailboxes) {
          this.deps.scheduleRetry?.(mailbox)
        }
      }
    )
  }

  deliverForHandle(mailbox: string, _notificationTypes?: ReadonlySet<string>): boolean {
    const db = this.deps.getDb()
    if (db && this.sourceDb !== db) {
      this.attachDatabase(db)
    }
    const target = this.deps.resolveStructuredTarget(mailbox)
    if (!target) {
      this.interests.delete(mailbox)
      this.dirty.delete(mailbox)
      this.deps.cancelRetry?.(mailbox)
      return false
    }
    const interest = this.interest(mailbox)
    if (!interest) {
      return true
    }
    for (const id of this.dirty.get(mailbox) ?? []) {
      interest.dirty.add(id)
    }
    this.dirty.delete(mailbox)
    interest.pending = true
    if (!interest.running) {
      interest.running = true
      void discoverMailSources({
        mailbox,
        interest,
        current: () => this.current(mailbox, interest),
        admission: () => this.deps.host.admission(interest.target.sessionId),
        offer: (source) =>
          offerMailSource({
            mailbox,
            interest,
            source,
            deps: this.deps,
            current: () => this.current(mailbox, interest),
            retire: (id) => this.retire(interest, id)
          }),
        retire: (id) => this.retire(interest, id),
        finished: () => {
          this.deps.cancelRetry?.(mailbox)
        }
      })
        .catch((error) => {
          console.warn('[orchestration] ordinary mail creation failed', { mailbox, error })
          interest.retry = true
          this.deps.scheduleRetry?.(mailbox)
        })
        .finally(() => {
          interest.running = false
          if (
            this.interests.get(mailbox) === interest &&
            (interest.pending || !this.current(mailbox, interest))
          ) {
            queueMicrotask(() => this.deliverForHandle(mailbox))
          }
        })
    }
    return true
  }

  onConsumerChange(mailbox: string, types?: readonly string[]): boolean {
    const interest = this.interests.get(mailbox)
    if (interest) {
      if (!interest.consumersChanged || (interest.consumerTypes && types)) {
        interest.consumerTypes = types
          ? new Set([...(interest.consumerTypes ?? []), ...types])
          : undefined
      }
      interest.consumersChanged = true
    }
    return this.deliverForHandle(mailbox)
  }
  nominateSources(mailbox: string, ids: readonly string[]): void {
    const pending = this.dirty.get(mailbox) ?? new Set<string>()
    this.dirty.set(mailbox, pending)
    for (const id of ids) {
      pending.add(id)
    }
    this.deliverForHandle(mailbox)
  }
  retryForHandle(mailbox: string): void {
    this.sourceDb?.mailSourceMutations.flushCommitted()
    const interest = this.interests.get(mailbox)
    if (interest) {
      interest.retry = true
    }
    this.deliverForHandle(mailbox)
  }
  resetForDatabaseChange(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.dirty.clear()
    this.sourceDb = null
    for (const mailbox of this.interests.keys()) {
      this.deps.cancelRetry?.(mailbox)
    }
    this.interests.clear()
  }
  onJournalActivity(sessionId: string): void {
    for (const [mailbox, interest] of this.interests) {
      if (interest.target.sessionId === sessionId) {
        try {
          const now = this.deps.host.admission(sessionId)
          if (
            now?.owner === interest.authority.owner &&
            now.generation === interest.authority.generation
          ) {
            interest.capacityImproved ||= now.queuedBytes < interest.authority.queuedBytes
            interest.authority = now
          }
          this.deliverForHandle(mailbox)
        } catch (error) {
          interest.retry = true
          this.deps.scheduleRetry?.(mailbox)
          console.warn('[orchestration] unfinished semantic mail notification', { mailbox, error })
        }
      }
    }
  }
  forgetSession(sessionId: string): void {
    for (const [mailbox, interest] of this.interests) {
      if (interest.target.sessionId === sessionId) {
        this.interests.delete(mailbox)
        this.deps.cancelRetry?.(mailbox)
      }
    }
  }

  private interest(mailbox: string): Interest | null {
    const db = this.deps.getDb()
    const target = this.deps.resolveStructuredTarget(mailbox)
    const authority = target && this.deps.host.admission(target.sessionId)
    if (!db || !target || !authority) {
      return null
    }
    let interest = this.interests.get(mailbox)
    if (!interest || interest.db !== db) {
      interest = {
        db,
        target,
        authority,
        frontier: 0,
        deferred: new MailDebts(),
        dirty: new Set(),
        running: false,
        pending: false,
        consumersChanged: false,
        capacityImproved: false,
        retry: false,
        authorityChanged: false
      }
      this.interests.set(mailbox, interest)
    } else if (
      interest.target.sessionId !== target.sessionId ||
      interest.authority.owner !== authority.owner ||
      interest.authority.generation !== authority.generation
    ) {
      interest = {
        ...interest,
        target,
        authority,
        running: false,
        pending: true,
        authorityChanged: true,
        dirty: new Set(interest.dirty),
        capacityImproved:
          interest.capacityImproved ||
          authority.queuedBytes < interest.authority.queuedBytes ||
          interest.target.sessionId !== target.sessionId
      }
      this.interests.set(mailbox, interest)
    }
    return interest
  }
  private current(mailbox: string, interest: Interest): boolean {
    if (
      this.deps.getDb() !== interest.db ||
      this.interests.get(mailbox) !== interest ||
      this.deps.resolveStructuredTarget(mailbox)?.sessionId !== interest.target.sessionId
    ) {
      return false
    }
    const authority = this.deps.host.admission(interest.target.sessionId)
    return (
      authority?.owner === interest.authority.owner &&
      authority.generation === interest.authority.generation
    )
  }

  private retire(interest: Interest, id: string): void {
    interest.deferred.delete(id)
    interest.dirty.delete(id)
  }
}
