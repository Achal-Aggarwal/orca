import { RpcNumber, RpcString } from './rpc-value-schemas'
import { z } from 'zod'

export const TerminalDaemonRestartSeveredParams = z.object({
  pid: RpcNumber.int().positive(),
  linuxStartTicks: RpcString.min(1).max(32),
  bootId: RpcString.min(1).max(64)
})
