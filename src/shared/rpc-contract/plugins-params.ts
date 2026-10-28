import { RpcBoolean, RpcOptionalUnknown, RpcString, RpcUnknown } from './rpc-value-schemas'
import { z } from 'zod'
import { isQualifiedPluginKey } from '../plugins/plugin-manifest'

export const PluginSetEnabledParams = z.object({
  pluginKey: RpcString.refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: RpcBoolean
})

export const PluginReadPanelEntryParams = z.object({
  pluginKey: RpcString.min(1),
  panelId: RpcString.min(1)
})

export const PluginInvokeCommandParams = z.object({
  pluginKey: RpcString.min(1),
  commandId: RpcString.min(1),
  args: RpcOptionalUnknown
})

export const PluginsPanelActionParams = RpcUnknown
