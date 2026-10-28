import { ScalarString } from './scalar-value-schemas'
import { z } from 'zod'

// Why: a WSL host's server is one per Linux login, so other Orca desktops may share it.
export const ORCAD_PEER_DESKTOPS_METHOD = 'host.peerDesktops'
// A desktop names its installation on its long-lived control socket, so peers tell installations apart.
export const ORCAD_DECLARE_CLIENT_METHOD = 'host.declareClient'

const ClientInstanceIdSchema = ScalarString.regex(/^[A-Za-z0-9_-]{8,128}$/)

export const OrcadDeclareClientParamsSchema = z
  .object({ clientInstanceId: ClientInstanceIdSchema })
  .strict()

/** The caller's own installation, so none of its sockets count as another desktop. */
export const OrcadPeerDesktopsParamsSchema = z
  .object({ clientInstanceId: ClientInstanceIdSchema.optional() })
  .strict()

/** Other desktop installations with a declared control socket open on this server right now. */
export const OrcadPeerDesktopsResultSchema = z.object({
  peers: z.array(z.object({ name: ScalarString }))
})

export type OrcadPeerDesktopsResult = z.infer<typeof OrcadPeerDesktopsResultSchema>
