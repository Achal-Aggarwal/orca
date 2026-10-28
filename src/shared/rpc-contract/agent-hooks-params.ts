import { RpcString } from './rpc-value-schemas'
import { z } from 'zod'

export const PrepareCodexForWslPaneParams = z
  .object({
    codexHome: RpcString.max(4_096),
    orcaCodexHome: RpcString.max(4_096),
    wslDistro: RpcString.trim()
      .min(1)
      .max(255)
      .regex(/^[^\\/\r\n]+$/)
  })
  .strict()
