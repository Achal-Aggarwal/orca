import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'

let nextRequestToken = 0

export async function callLocalGitRead<T>(
  load: (requestToken?: string) => Promise<T>,
  cancelRequest: (requestToken: string) => Promise<void>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return load()
  }
  throwIfSignalAborted(signal)
  const requestToken = `git-read-${Date.now()}-${++nextRequestToken}`
  const cancel = (): void => {
    void cancelRequest(requestToken).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const result = await waitForPromiseWithSignal(load(requestToken), signal)
    throwIfSignalAborted(signal)
    return result
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
