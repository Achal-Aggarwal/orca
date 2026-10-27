import type { z } from 'zod'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../../ai-vault/structured-session-ownership'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { TerminalSend } from '../../../../../shared/rpc-contract/terminal-unary-params'
import { assertTerminalSendTextWithinLimit } from './terminal-input-delivery'

export async function assertTerminalSendTextsAdmitted(
  params: z.infer<typeof TerminalSend>,
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>
): Promise<void> {
  await assertTerminalSendTextWithinLimit(params.text)
  await assertTerminalSendTextWithinLimit(params.resolvedLaunchDraft?.text)
  if (params.text) {
    await assertLegacyAiVaultResumeCommandAllowed(params.text, () =>
      runtime.ensureStructuredAgentSessionHost()
    )
  }
  if (params.resolvedLaunchDraft?.text) {
    await assertLegacyAiVaultResumeCommandAllowed(params.resolvedLaunchDraft.text, () =>
      runtime.ensureStructuredAgentSessionHost()
    )
  }
}
