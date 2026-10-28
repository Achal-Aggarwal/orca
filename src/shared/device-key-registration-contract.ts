import { ScalarString } from './scalar-value-schemas'
import { z } from 'zod'
import { isDeviceProofB64, isDevicePublicKeyB64 } from './device-key-proof'

export const RegisterDeviceKeyParamsSchema = z
  .object({
    devicePublicKeyB64: ScalarString.refine(isDevicePublicKeyB64, 'expected a 32-byte Ed25519 key'),
    // Ed25519 over encodeDeviceProofMessage('register', this connection's v2 transcript hash).
    deviceProofB64: ScalarString.refine(isDeviceProofB64, 'expected a 64-byte signature'),
    deviceLabel: ScalarString.max(256).optional(),
    // Session-only keys expire on restart/idle; send only with ephemeral capability because older host params are strict.
    ephemeral: z.literal(true).optional()
  })
  .strict()

export type RegisterDeviceKeyParams = z.infer<typeof RegisterDeviceKeyParamsSchema>

export type RegisterDeviceKeyResult = {
  deviceId: string
  credentialRevision: number
}
