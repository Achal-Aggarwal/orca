import { ScalarNumber, ScalarString } from './scalar-value-schemas'
import { z } from 'zod'

const AccessRequest = z.object({
  selector: ScalarString.trim().min(1).max(1024),
  requestId: ScalarString.regex(/^[a-zA-Z0-9_-]{1,128}$/)
})

export const RuntimeSshAccessLinkRequestSchema = AccessRequest.extend({
  sshTargetId: ScalarString.trim().min(1).max(1024),
  remotePort: ScalarNumber.int().min(1).max(65_535)
}).strict()
export const RuntimeSshAccessUnlinkRequestSchema = AccessRequest.strict()

export type RuntimeSshAccessLinkRequest = z.infer<typeof RuntimeSshAccessLinkRequestSchema>
export type RuntimeSshAccessUnlinkRequest = z.infer<typeof RuntimeSshAccessUnlinkRequestSchema>
