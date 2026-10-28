import { RpcString } from './rpc-value-schemas'
import { z } from 'zod'

export const JiraFavouriteFilterParams = z.strictObject({
  siteId: RpcString.trim()
    .min(1)
    .max(128)
    .refine((siteId) => siteId !== 'all')
})
