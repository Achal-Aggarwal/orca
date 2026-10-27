import type { Session } from './session'
import type { PtyProcessInspectionOptions } from '../providers/pty-process-inspection'
import { getAliveTerminalHostSession } from './terminal-host-session-access'
import { resolveTerminalHostSessionCwd } from './terminal-host-session-cwd'
import {
  inspectTerminalHostSession,
  type TerminalHostProcessInspection
} from './terminal-host-process-inspection'
import {
  confirmTerminalHostForegroundProcess,
  confirmTerminalHostShellForeground
} from './terminal-host-session-inspection-operations'

export abstract class TerminalHostInspection {
  protected abstract sessions: Map<string, Session>
  protected abstract readonly retiredIncarnations: Map<
    string,
    { incarnationId: string; code: number; expiresAt: number }
  >
  protected abstract readonly authorityGeneration: string
  protected abstract observationEpoch: number
  async getCwd(sessionId: string): Promise<string | null> {
    return await resolveTerminalHostSessionCwd(
      getAliveTerminalHostSession(this.sessions, sessionId)
    )
  }

  // A vanished pane has no agent icon to display.
  getForegroundProcess(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getForegroundProcess()
  }

  inspectProcess(
    sessionId: string,
    options?: PtyProcessInspectionOptions
  ): Promise<TerminalHostProcessInspection> {
    return inspectTerminalHostSession(
      this.sessions,
      this.retiredIncarnations,
      sessionId,
      options,
      this.authorityGeneration,
      () => ++this.observationEpoch
    )
  }

  async confirmForegroundProcess(sessionId: string): Promise<string | null> {
    return confirmTerminalHostForegroundProcess(this.sessions.get(sessionId))
  }

  async confirmShellForeground(sessionId: string): Promise<boolean> {
    return confirmTerminalHostShellForeground(this.sessions.get(sessionId), () =>
      this.sessions.get(sessionId)
    )
  }
}
