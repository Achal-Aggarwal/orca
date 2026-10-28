import { RpcOptionalBoolean, RpcString } from './rpc-value-schemas'
import { z } from 'zod'

export const ClientUiWorkspaceFilterFields = {
  hideDefaultBranchWorkspace: RpcOptionalBoolean,
  hideAutomationGeneratedWorkspaces: RpcOptionalBoolean,
  hideCliCreatedWorkspaces: RpcOptionalBoolean,
  hideDetachedHeadWorkspaces: RpcOptionalBoolean,
  hideWorkspacesFromOtherDevices: RpcOptionalBoolean,
  alwaysShowDefaultBranchWorkspace: RpcOptionalBoolean,
  filterRepoIds: z.array(RpcString).optional()
}
