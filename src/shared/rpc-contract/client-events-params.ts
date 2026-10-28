import { RpcString, RpcUnknown } from './rpc-value-schemas'
import { z } from 'zod'

export const ClientEventsUnsubscribeParams = z.object({
  subscriptionId: RpcUnknown.transform((value) =>
    typeof value === 'string' && value.length > 0 ? value : ''
  ).pipe(RpcString.min(1, 'Missing subscriptionId'))
})
