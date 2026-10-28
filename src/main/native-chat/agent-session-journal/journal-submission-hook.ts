import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'

/** Claim attachments atomically; required rejects missing uploads except references retained from previous. */
export type JournalAttachmentClaim = (
  db: Database.Database,
  body: AgentJournalMessageItem,
  required: boolean,
  previous?: AgentJournalMessageItem,
  goalId?: string
) => (() => void) | void

import { composeJournalOperationReceipts, type JournalOperationReceipt } from './journal-row-writer'

/** Committed accepted inputs revoke any live permission to retract their protection. */
export function journalAttachmentClaimsReceipt(
  claim: JournalAttachmentClaim,
  bodies: readonly AgentJournalMessageItem[],
  receipt: JournalOperationReceipt
): JournalOperationReceipt {
  const commits: (() => void)[] = []
  return composeJournalOperationReceipts(
    {
      write: (db) => {
        for (const body of bodies) {
          const commit = claim(db, body, false)
          if (commit) {
            commits.push(commit)
          }
        }
      },
      committed: () => commits.forEach((commit) => commit())
    },
    receipt
  )
}

export function journalAttachmentClaimReceipt(
  claim: (db: Database.Database) => (() => void) | void,
  afterCommit: () => void = () => {}
): JournalOperationReceipt {
  let committed: (() => void) | void
  return {
    write: (db) => {
      committed = claim(db)
    },
    committed: () => {
      committed?.()
      afterCommit()
    }
  }
}
