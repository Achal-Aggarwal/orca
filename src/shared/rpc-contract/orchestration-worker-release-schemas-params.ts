import { RpcNumber, RpcOptionalBoolean, RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'
import { ORCHESTRATION_FLEET_PAGE_MAX } from '../orchestration-fleet-projection'

export const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })

export const WorkerRetainParams = WorkerDispatchParams.strict()

export const WORKER_TERMINAL_LIST_STATES = [
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'released'
] as const

export const WorkerListParams = z.object({
  run: RpcString.min(1).optional(),
  terminalState: z.enum(WORKER_TERMINAL_LIST_STATES).optional(),
  cursor: RpcString.min(1).max(2_048).optional(),
  limit: RpcNumber.int().min(1).max(ORCHESTRATION_FLEET_PAGE_MAX).optional(),
  includeRemote: RpcOptionalBoolean,
  paginate: RpcOptionalBoolean
})
