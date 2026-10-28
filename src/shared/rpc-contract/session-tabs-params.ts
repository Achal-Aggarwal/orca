import { RpcString } from './rpc-value-schemas'
import { z } from 'zod'

export const SessionTabsUnsubscribeAllParams = z
  .object({
    subscriptionId: RpcString.min(1).optional()
  })
  .nullish()
