import { RpcString } from './rpc-value-schemas'
import { z } from 'zod'

export const OrchestrationWorkerTerminalUserInputParams = z
  .object({
    paneKey: RpcString.min(1).optional(),
    sessionId: RpcString.min(1).optional(),
    terminal: RpcString.min(1).optional()
  })
  .refine(
    (value) => Boolean(value.paneKey ?? value.sessionId ?? value.terminal),
    'Missing paneKey, sessionId or terminal'
  )
