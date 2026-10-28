const capacityListeners = new Set<() => void>()
let capacityNotificationPending = false
let capacityNotificationVersion = 0

export function subscribeToLocalImageCacheCapacity(listener: () => void): () => void {
  capacityListeners.add(listener)
  return () => capacityListeners.delete(listener)
}

export function notifyLocalImageCacheCapacity(): void {
  if (capacityNotificationPending || capacityListeners.size === 0) {
    return
  }
  capacityNotificationPending = true
  const version = capacityNotificationVersion
  queueMicrotask(() => {
    if (version !== capacityNotificationVersion) {
      return
    }
    capacityNotificationPending = false
    for (const listener of capacityListeners) {
      listener()
    }
  })
}
export function resetLocalImageCacheCapacityEvents(): void {
  capacityListeners.clear()
  capacityNotificationPending = false
  capacityNotificationVersion += 1
}
