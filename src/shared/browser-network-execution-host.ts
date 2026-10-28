import { ScalarNonemptyString, ScalarNonnegativeInteger } from './scalar-value-schemas'
import { z } from 'zod'

const Identity = ScalarNonemptyString.max(256)

const BrowserNetworkNativeExecutionHost = z.object({
  kind: z.literal('native'),
  runtimeId: Identity,
  revision: ScalarNonnegativeInteger.max(Number.MAX_SAFE_INTEGER)
})

const BrowserNetworkSshExecutionHost = z.object({
  kind: z.literal('ssh'),
  targetId: Identity,
  providerEpoch: Identity,
  connectionGeneration: ScalarNonnegativeInteger.max(Number.MAX_SAFE_INTEGER)
})

const BrowserNetworkWslExecutionHost = z.object({
  kind: z.literal('wsl'),
  runtimeId: Identity,
  revision: ScalarNonnegativeInteger.max(Number.MAX_SAFE_INTEGER),
  distro: Identity
})

export const BrowserNetworkExecutionHost = z.discriminatedUnion('kind', [
  BrowserNetworkNativeExecutionHost,
  BrowserNetworkSshExecutionHost,
  BrowserNetworkWslExecutionHost
])

export type BrowserNetworkExecutionHost = z.infer<typeof BrowserNetworkExecutionHost>
