import { RpcString } from './rpc-value-schemas'
import { z } from 'zod'

// Why trimmed: the stores trim before saving, so a blank paste must fail here, not as "required".
// Why bounded: a pasted value larger than any real key or Cookie header is a mistake, not a credential.
export const UsageCredentialApiKeyParams = z.strictObject({
  apiKey: RpcString.trim().min(1).max(4_096)
})

export const UsageCredentialSessionCookieParams = z.strictObject({
  cookie: RpcString.trim().min(1).max(65_536)
})
