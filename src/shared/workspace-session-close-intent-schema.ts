import { ScalarNonemptyString } from './scalar-value-schemas'

import { clientHostedBrowserCloseIntentSchema } from './client-hosted-browser-close-intent'
import { pairedTerminalTabCloseIntentSchema } from './paired-terminal-tab-close-intent'
import { salvagedOptional, salvagingArray, salvagingRecord } from './zod-salvage'

/** The session fields holding closes this client owes a runtime environment, keyed by it. */
export const workspaceSessionCloseIntentFieldSchemas = {
  clientHostedBrowserCloseIntentsByEnvironment: salvagedOptional(
    'clientHostedBrowserCloseIntentsByEnvironment',
    salvagingRecord(ScalarNonemptyString, salvagingArray(clientHostedBrowserCloseIntentSchema))
  ),
  pairedTerminalTabCloseIntentsByEnvironment: salvagedOptional(
    'pairedTerminalTabCloseIntentsByEnvironment',
    salvagingRecord(ScalarNonemptyString, salvagingArray(pairedTerminalTabCloseIntentSchema))
  )
}
