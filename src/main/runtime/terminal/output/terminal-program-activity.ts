import type { AgentStatus } from '../../../../shared/agent-detection'
import { OrcaRuntimeWithApplyTrackedPtyTitle } from './terminal-title-observation'

/** The program's OSC 7501 activity, and re-classifying the PTY's status when it or a hook row moves. */
export abstract class OrcaRuntimeWithApplyPtyProgramActivity extends OrcaRuntimeWithApplyTrackedPtyTitle {
  /** Re-classifies the PTY under new program activity; on null the title's own glyph decides again. */
  protected applyPtyProgramActivity(ptyId: string, activity: AgentStatus | null): void {
    const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (!entry) {
      return
    }
    entry.programActivity = activity
    this.observeClaudeTerminalEvidence(ptyId, { kind: 'activity', status: activity })
    const pty = this.ptysById.get(ptyId)
    if (activity === null && pty?.lastExplicitAgentStatus?.programAtRest) {
      // The at-rest claim was the program's; a later agent in this pane must earn its own.
      const { programAtRest: _ended, ...status } = pty.lastExplicitAgentStatus
      pty.lastExplicitAgentStatus = status
    }
    this.reclassifyPtyStatus(ptyId)
  }

  /** Re-offers the last title's status, e.g. when a hook row ends a turn under program `working`. */
  protected reclassifyPtyStatus(ptyId: string): void {
    const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (!entry?.lastTitle) {
      return
    }
    // A stale-spinner clear stands for the title it replaced, so a dead spinner is not revived.
    const raw = this.ptysById.get(ptyId)?.titleDisplayClear?.title ?? entry.lastTitle.raw
    const changed = this.applyTrackedPtyTitle(ptyId, raw, entry.lastTitle.normalized, undefined, {
      statusOnly: true
    })
    // The chunk's session-tab fan-out carries the new status to mobile.
    if (changed && entry.applyingChunk) {
      entry.chunkTouchedSessionTabs = true
    }
  }
}
