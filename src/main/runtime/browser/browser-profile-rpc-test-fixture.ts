import '../rpc/unused-default-rpc-methods.test-fixture'
import type { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from '../rpc/dispatcher'
import { BROWSER_PROFILE_METHODS } from '../rpc/methods/browser-profile-rpc-methods'
import { RuntimeBrowserProfiles } from './browser-profiles'

export function browserProfileRpcFixture(executorRuntimeId: string, outerRuntimeId = 'D') {
  const unavailable = () => {
    throw new Error('unused page target')
  }
  const profiles = new RuntimeBrowserProfiles(
    {
      getRuntimeId: () => executorRuntimeId,
      getAuthoritativeWindow: unavailable,
      getRuntimeBrowserPageRegistry: unavailable,
      getBrowserHostLeaseRegistry: unavailable
    },
    { requireAgentBrowserBridge: unavailable, resolveBrowserCommandTarget: async () => ({}) },
    { describeBrowserTab: unavailable, resolveClientHostedBrowserPage: async () => null }
  )
  const runtime = {
    getRuntimeId: () => outerRuntimeId,
    browserProfileList: () => profiles.browserProfileList(),
    browserProfileImportFromBrowser: profiles.browserProfileImportFromBrowser.bind(profiles),
    browserProfileClearGoogleCookies: profiles.browserProfileClearGoogleCookies.bind(profiles)
    // SAFETY: this explicit registry invokes only these three runtime methods; page/orchestration methods are excluded.
  } as OrcaRuntimeService
  return { profiles, dispatcher: new RpcDispatcher({ runtime, methods: BROWSER_PROFILE_METHODS }) }
}
