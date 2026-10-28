import { RpcOptionalNonemptyString } from './rpc-value-schemas'
import { z } from 'zod'

export const SessionTabsUnsubscribeAllParams = z
  .object({
    subscriptionId: RpcOptionalNonemptyString
  })
  .nullish()
