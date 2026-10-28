import { RpcString } from './rpc-value-schemas'
import { z } from 'zod'

export const ScreencastUnsubscribe = z.object({
  subscriptionId: RpcString.min(1, 'Missing required --subscription-id')
})
