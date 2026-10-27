import { cancelDesktopTerminalRetirement } from '../../../automations/desktop-run-terminal-lifecycle'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { ptyIncarnationById } from './ownership-state'

export async function shutdownProviderAndDetectExit(
  provider: IPtyProvider,
  id: string,
  opts: Parameters<IPtyProvider['shutdown']>[1]
): Promise<boolean> {
  if (!opts.authorizeStop) {
    cancelDesktopTerminalRetirement(id)
  }
  let providerExitObserved = false
  const expectedIncarnationId = opts.expectedIncarnationId ?? ptyIncarnationById.get(id)
  const unsubscribe = provider.onExit((payload) => {
    if (
      payload.id === id &&
      (!expectedIncarnationId || payload.incarnationId === expectedIncarnationId)
    ) {
      providerExitObserved = true
    }
  })
  try {
    await provider.shutdown(id, opts)
  } finally {
    unsubscribe()
  }
  return providerExitObserved
}
