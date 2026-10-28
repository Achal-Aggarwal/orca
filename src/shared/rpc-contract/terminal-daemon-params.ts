import { RpcString, RpcPositiveInteger } from './rpc-value-schemas'
import { z } from 'zod'

export const TerminalDaemonRestartSeveredParams = z.object({
  pid: RpcPositiveInteger,
  linuxStartTicks: RpcString.min(1).max(32),
  bootId: RpcString.min(1).max(64)
})
