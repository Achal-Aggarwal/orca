import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { ReattachPayloadContext } from './reattach-payload-context'
import type { ReattachPayloadSession } from './reattach-payload-session'

export function scheduleLateReattachResume(
  session: ReattachPayloadSession,
  ctx: ReattachPayloadContext,
  lateStartup: ColdRestoreAgentResumeStartup,
  inputAt: number
): void {
  if (session.runtimeEnvironmentId) {
    const current = () =>
      ctx.isCurrentReattachPayload() &&
      session.transport.getPtyId() === ctx.ptyId &&
      session.lastTerminalInputAt === inputAt
    const pending = session.pendingStartupCommand
    if (
      !pending ||
      (pending.command === lateStartup.command && pending.resumeSource === lateStartup.resumeSource)
    ) {
      session.pendingStartupCommand = {
        command: lateStartup.command,
        resumeSource: lateStartup.resumeSource,
        isCurrent: current
      }
      ctx.resumeAfterReplay = () => {
        if (current()) {
          session.schedulePendingStartupCommandDelivery()
        }
      }
    }
  } else {
    ctx.resumeAfterReplay = () => {
      if (
        !ctx.isCurrentReattachPayload() ||
        session.transport.getPtyId() !== ctx.ptyId ||
        session.lastTerminalInputAt !== inputAt
      ) {
        return
      }
      session.pendingReplacedPtyId = ctx.ptyId
      session.transport.disconnect()
      void session.startFreshColdRestoreAgentResume(lateStartup)
    }
  }
}
