import {
  RpcBoolean,
  RpcOptionalUnknown,
  RpcString,
  RpcUnknown,
  RpcNonemptyString
} from './rpc-value-schemas'
import { z } from 'zod'
import { isQualifiedPluginKey } from '../plugins/plugin-manifest'

export const PluginSetEnabledParams = z.object({
  pluginKey: RpcString.refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: RpcBoolean
})

export const PluginReadPanelEntryParams = z.object({
  pluginKey: RpcNonemptyString,
  panelId: RpcNonemptyString
})

export const PluginInvokeCommandParams = z.object({
  pluginKey: RpcNonemptyString,
  commandId: RpcNonemptyString,
  args: RpcOptionalUnknown
})

export const PluginsPanelActionParams = RpcUnknown
