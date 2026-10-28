import { ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS } from '../../shared/orchestration-message-wait-timeout'

export type MessageWaitResult = 'notified' | 'timed_out' | 'cancelled'

/** A notified check retains its opportunity until its actual read/reserve continuation finishes. */
export class MessageWaitScope {
  private release: (() => void) | undefined
  bind(release: () => void): void {
    const previous = this.release
    this.release = release
    previous?.()
  }
  complete(): boolean {
    const release = this.release
    this.release = undefined
    release?.()
    return release !== undefined
  }
}

export type RuntimeMessageWaiter = {
  handle: string
  typeFilter: string[] | undefined
  resolve: (result: MessageWaitResult) => void
  timeout: NodeJS.Timeout | null
  abortCleanup: (() => void) | null
  notified: boolean
  scope?: MessageWaitScope
}

export class RuntimeMessageWaiters {
  constructor(private readonly onRelease?: (handle: string, types?: readonly string[]) => void) {}
  private readonly waitersByHandle = new Map<string, Set<RuntimeMessageWaiter>>()

  notifyRouted(handle: string, types: readonly string[]): void {
    if (types.length === 0) {
      return
    }
    const waiters = [...(this.waitersByHandle.get(handle) ?? [])]
    queueMicrotask(() => {
      for (const waiter of waiters) {
        if (
          this.waitersByHandle.get(handle)?.has(waiter) &&
          (!waiter.typeFilter || types.some((type) => waiter.typeFilter?.includes(type)))
        ) {
          this.resolve(waiter, 'notified')
        }
      }
    })
  }

  observe(handle: string, scope: MessageWaitScope, typeFilter?: string[]): void {
    const waiter: RuntimeMessageWaiter = {
      handle,
      typeFilter,
      scope,
      resolve: () => {},
      timeout: null,
      abortCleanup: null,
      notified: true
    }
    const waiters = this.waitersByHandle.get(handle) ?? new Set<RuntimeMessageWaiter>()
    this.waitersByHandle.set(handle, waiters)
    waiters.add(waiter)
    scope.bind(() => this.remove(waiter))
  }

  wait(
    handle: string,
    options?: {
      typeFilter?: string[]
      timeoutMs?: number
      signal?: AbortSignal
      scope?: MessageWaitScope
    }
  ): Promise<MessageWaitResult> {
    return new Promise((resolve) => {
      const waiter: RuntimeMessageWaiter = {
        handle,
        typeFilter: options?.typeFilter,
        resolve,
        timeout: null,
        abortCleanup: null,
        notified: false,
        scope: options?.scope
      }
      const waiters = this.waitersByHandle.get(handle) ?? new Set()
      this.waitersByHandle.set(handle, waiters)
      waiters.add(waiter)
      options?.scope?.bind(() => this.remove(waiter))
      const signal = options?.signal
      if (signal?.aborted) {
        this.resolve(waiter, 'cancelled')
        return
      }
      if (signal) {
        const onAbort = () => this.resolve(waiter, 'cancelled')
        waiter.abortCleanup = () => signal.removeEventListener('abort', onAbort)
        signal.addEventListener('abort', onAbort, { once: true })
      }
      waiter.timeout = setTimeout(
        () => this.resolve(waiter, 'timed_out'),
        options?.timeoutMs ?? ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS
      )
    })
  }

  cancel(handle: string): void {
    for (const waiter of this.waitersByHandle.get(handle) ?? []) {
      this.resolve(waiter, 'cancelled')
    }
  }

  dispose(): void {
    for (const waiters of this.waitersByHandle.values()) {
      for (const waiter of waiters) {
        this.remove(waiter, false)
        this.resolve(waiter, 'cancelled')
      }
    }
  }

  consumerCompleted(handle: string, types?: readonly string[]): void {
    try {
      this.onRelease?.(handle, types)
    } catch (error) {
      console.warn('[orchestration] notifying completed mail consumer failed', error)
    }
  }

  get(handle: string): ReadonlySet<RuntimeMessageWaiter> | undefined {
    return this.waitersByHandle.get(handle)
  }
  get map(): ReadonlyMap<string, ReadonlySet<RuntimeMessageWaiter>> {
    return this.waitersByHandle
  }
  resolveNotified(waiter: RuntimeMessageWaiter): void {
    this.resolve(waiter, 'notified')
  }

  private resolve(waiter: RuntimeMessageWaiter, result: MessageWaitResult): void {
    if (waiter.notified) {
      return
    }
    waiter.notified = true
    this.cleanup(waiter)
    if (!waiter.scope) {
      this.remove(waiter)
    }
    waiter.resolve(result)
  }

  private cleanup(waiter: RuntimeMessageWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
    }
    waiter.timeout = null
    waiter.abortCleanup?.()
    waiter.abortCleanup = null
  }
  private remove(waiter: RuntimeMessageWaiter, notify = true): void {
    this.cleanup(waiter)
    const waiters = this.waitersByHandle.get(waiter.handle)
    if (!waiters?.delete(waiter)) {
      return
    }
    if (waiters.size === 0) {
      this.waitersByHandle.delete(waiter.handle)
    }
    if (notify) {
      this.consumerCompleted(waiter.handle, waiter.typeFilter)
    }
  }
}
