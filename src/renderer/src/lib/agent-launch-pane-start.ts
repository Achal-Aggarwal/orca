// Session-only: this pane's own spawn answers first, and its answer gates the prompt's paste.

const pendingStarts = new Map<
  string,
  { resolve?: (startedPtyId: string | null) => void; operationId?: string; awaitingHost?: boolean }
>()

// Not `makePaneKey`: that validates the leaf id, and a launch must never fail over bookkeeping.
function startKey(tabId: string, leafId: string): string {
  return JSON.stringify([tabId, leafId])
}

/** Registered before the pane exists, so its first spawn already answers it: with its PTY, or null. */
export function awaitAgentLaunchPaneStart(tabId: string, leafId: string): Promise<string | null> {
  const key = startKey(tabId, leafId)
  pendingStarts.get(key)?.resolve?.(null)
  return new Promise((resolve) => {
    pendingStarts.set(key, { ...pendingStarts.get(key), resolve })
  })
}

export function settleAgentLaunchPaneStart(
  tabId: string | undefined,
  leafId: string | undefined,
  startedPtyId: string | null
): void {
  if (tabId && leafId) {
    const key = startKey(tabId, leafId)
    const settle = pendingStarts.get(key)
    const resolve = settle?.resolve
    if (settle) {
      settle.resolve = undefined
    }
    resolve?.(startedPtyId)
  }
}

/** New addressed work wins before launch preparation or a late old verdict. */
export function acceptAgentLaunchPaneAttempt(paneKey: string, operationId?: string): void {
  const split = paneKey.indexOf(':')
  if (split === -1) {
    return
  }
  const key = startKey(paneKey.slice(0, split), paneKey.slice(split + 1))
  const entry = pendingStarts.get(key)
  entry?.resolve?.(null)
  pendingStarts.set(key, { operationId, awaitingHost: true })
}
export function confirmAgentLaunchPaneAttempt(
  tabId: string,
  leafId: string,
  operationId?: string
): void {
  const key = startKey(tabId, leafId)
  const current = pendingStarts.get(key)
  if (current?.awaitingHost && current.operationId !== operationId) {
    return
  }
  if (current?.operationId !== operationId) {
    current?.resolve?.(null)
  }
  pendingStarts.set(key, { ...current, operationId, awaitingHost: false })
}

export function agentLaunchPaneAttemptCurrent(
  tabId: string,
  leafId: string,
  operationId?: string
): boolean {
  const entry = pendingStarts.get(startKey(tabId, leafId))
  return !entry || entry.operationId === operationId
}

export function forgetAgentLaunchPaneAttempts(tabId: string, leafId?: string): void {
  for (const [key, entry] of pendingStarts) {
    if (JSON.parse(key)[0] === tabId && (leafId === undefined || JSON.parse(key)[1] === leafId)) {
      entry.resolve?.(null)
      pendingStarts.delete(key)
    }
  }
}
