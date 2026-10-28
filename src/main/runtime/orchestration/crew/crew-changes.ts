export class CrewChanges {
  private readonly listeners = new Set<() => void>()
  private queued = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  notify = (): void => {
    if (this.queued || this.listeners.size === 0) {
      return
    }
    this.queued = true
    // Database mutations are synchronous; readers run after their outer transaction finishes.
    queueMicrotask(() => {
      this.queued = false
      for (const listener of this.listeners) {
        listener()
      }
    })
  }
}

export const sessionCrewChanges = new CrewChanges()
