import {
  RpcBoolean,
  RpcNumber,
  RpcOptionalBoolean,
  RpcOptionalString,
  RpcString,
  RpcUnknown
} from './rpc-value-schemas'
import { z } from 'zod'
import { MOBILE_PUSH_APNS_ENVIRONMENTS, MOBILE_PUSH_PLATFORMS } from '../mobile-push-contract'

export const NotificationUnsubscribeParams = z.object({
  subscriptionId: RpcUnknown.transform((value) =>
    typeof value === 'string' && value.length > 0 ? value : ''
  ).pipe(RpcString.min(1, 'Missing subscriptionId'))
})

// Catch up after the delivered sequence (#8129); epoch identifies its counter lifetime across desktop restarts
// (#8591). Old clients retain seq-only cuts; replaying a watermark cannot duplicate already-delivered sequences.
export const NotificationGetMissedSinceParams = z.object({
  lastSeenSeq: RpcNumber.int().min(0, 'lastSeenSeq must be a non-negative integer'),
  epoch: RpcOptionalString,
  includeDesktopSuppressed: RpcOptionalBoolean,
  deliveredPushes: z
    .array(
      z.object({
        notificationId: RpcString.min(1).max(2048),
        notificationEpoch: RpcString.min(1).max(128),
        notificationSeq: RpcNumber.int().min(0).max(Number.MAX_SAFE_INTEGER)
      })
    )
    .max(256)
    .optional()
})

export const NotificationPushFilterParams = z.object({
  onlyWhenDesktopAway: RpcOptionalBoolean,
  sound: RpcOptionalBoolean
})

export const NotificationRegisterPushParams = z
  .object({
    platform: z.enum(MOBILE_PUSH_PLATFORMS),
    token: RpcString.min(1).max(4096),
    apnsEnvironment: z.enum(MOBILE_PUSH_APNS_ENVIRONMENTS).optional(),
    filter: NotificationPushFilterParams
  })
  // Device identity is handler-owned; reject caller-supplied deviceId instead of silently dropping it.
  .strict()
  // APNs tokens require their minting environment; never default a missing one to production.
  .refine((params) => params.platform !== 'ios' || params.apnsEnvironment !== undefined, {
    message: 'apnsEnvironment is required for ios'
  })

export const NotificationsSubscribeParams = z
  .object({ includeDesktopSuppressed: RpcOptionalBoolean })
  .optional()

export const NotificationReportDesktopPresenceParams = z.object({ away: RpcBoolean })
