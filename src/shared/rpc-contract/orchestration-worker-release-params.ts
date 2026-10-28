import { RpcOptionalNonemptyString } from './rpc-value-schemas'
import { z } from 'zod'

export const OrchestrationWorkerTerminalUserInputParams = z
  .object({
    paneKey: RpcOptionalNonemptyString,
    sessionId: RpcOptionalNonemptyString,
    terminal: RpcOptionalNonemptyString
  })
  .refine(
    (value) => Boolean(value.paneKey ?? value.sessionId ?? value.terminal),
    'Missing paneKey, sessionId or terminal'
  )
