import { RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import { SkillDiscoveryTargetSchema } from '../skills'

export const SkillsGetInstallProgressParams = z
  .object({ operationId: RpcString.min(1).max(128) })
  .strict()

export const SkillsCancelInstallParams = z
  .object({ operationId: RpcString.min(1).max(128) })
  .strict()

export const SkillsDiscoverParams = SkillDiscoveryTargetSchema.default({})
