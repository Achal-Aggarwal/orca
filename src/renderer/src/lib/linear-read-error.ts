import { translate } from '@/i18n/i18n'
import {
  credentialDecryptionMessage,
  isIntegrationCredentialDecryptionError
} from '../../../shared/integration-credential-errors'
import { isLinearIssueAttributeFilterUnsupportedError } from '@/runtime/runtime-linear-client'

export function linearIssueReadError(error: unknown): string {
  if (isIntegrationCredentialDecryptionError(error)) {
    return credentialDecryptionMessage('Linear')
  }
  if (isLinearIssueAttributeFilterUnsupportedError(error)) {
    return error.message
  }
  return `${translate('auto.components.TaskPage.cc8795e07c', 'Unable to load Linear issues')}. ${translate('auto.store.slices.runtime.status.tryAgain', 'Try again')}.`
}
