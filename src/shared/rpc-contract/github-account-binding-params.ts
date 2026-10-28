import { RpcOptionalBoolean } from './rpc-value-schemas'
import { RepoSelector } from './github-repo-target-params'
import { requiredString } from './rpc-param-primitives'

export const BindableAccounts = RepoSelector.extend({
  refreshCapability: RpcOptionalBoolean
})

export const ValidateAccountBinding = RepoSelector.extend({
  host: requiredString('Missing host'),
  user: requiredString('Missing user')
})
