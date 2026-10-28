export const TS_PROGRAM_IDLE_REFRESH_MS = 60_000

export function createMonacoTsProgramIdleRefresh(
  refresh: () => void,
  delayMs = TS_PROGRAM_IDLE_REFRESH_MS
): {
  retired(): void
  activity(): void
  request<T>(operation: () => Promise<T>): Promise<T>
  dispose(): void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = 0
  let dirty = false
  let disposed = false
  const cancel = (): void => {
    clearTimeout(timer)
    timer = undefined
  }
  const schedule = (): void => {
    cancel()
    if (!dirty || pending > 0 || disposed) {
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      dirty = false
      refresh()
    }, delayMs)
  }
  return {
    retired() {
      dirty = true
      schedule()
    },
    activity: schedule,
    async request(operation) {
      pending += 1
      cancel()
      try {
        return await operation()
      } finally {
        pending -= 1
        schedule()
      }
    },
    dispose() {
      disposed = true
      dirty = false
      cancel()
    }
  }
}
