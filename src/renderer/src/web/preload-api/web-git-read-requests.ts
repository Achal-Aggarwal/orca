import { callAbortableRuntimeEnvironment } from '../../runtime/abortable-runtime-environment-call'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironment, updateEnvironmentFromResponse } from './web-runtime-session'

export const webGitReadAbortControllers = new Map<string, AbortController>()

export async function callRuntimeGitRead<TResult>(
  method: string,
  resolveParams: () => Promise<unknown>,
  requestToken?: string
): Promise<TResult> {
  if (!requestToken) {
    return callRuntimeResult(method, await resolveParams())
  }
  const environment = requireActiveEnvironment()
  webGitReadAbortControllers.get(requestToken)?.abort()
  const controller = new AbortController()
  webGitReadAbortControllers.set(requestToken, controller)
  try {
    const params = await resolveParams()
    controller.signal.throwIfAborted()
    const response = await callAbortableRuntimeEnvironment(
      environment.id,
      method,
      params,
      undefined,
      controller.signal
    )
    updateEnvironmentFromResponse(environment, response)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    // SAFETY: the method-specific runtime contract supplies TResult after its successful response.
    return response.result as TResult
  } finally {
    if (webGitReadAbortControllers.get(requestToken) === controller) {
      webGitReadAbortControllers.delete(requestToken)
    }
  }
}
