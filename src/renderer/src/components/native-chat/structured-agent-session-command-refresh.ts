import { useCallback, useEffect, useRef, useState } from 'react'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  AgentSessionCommandsResult,
  AgentSessionSlashCommand
} from '../../../../shared/agent-session-wire'
import { startAgentSessionCommandMenuQuery } from '../../../../shared/agent-session-command-menu-query'

export function useStructuredAgentSessionCommandMenu(
  target: RuntimeClientTarget,
  sessionId: string,
  enabled: boolean,
  commands: AgentSessionSlashCommand[] | null | undefined
) {
  const [open, setOpen] = useState(false)
  const query = useRef<ReturnType<typeof startAgentSessionCommandMenuQuery> | null>(null)
  const previous = useRef(commands)
  useEffect(() => {
    if (!enabled || !open) {
      return
    }
    const owned = startAgentSessionCommandMenuQuery(
      () =>
        callStructuredAgentSession<AgentSessionCommandsResult>(target, 'agentSession.commands', {
          sessionId
        }),
      () => {}
    )
    query.current = owned
    return () => {
      query.current = null
      owned.dispose()
    }
  }, [enabled, open, sessionId, target])
  useEffect(() => {
    if (previous.current != null && commands == null) {
      query.current?.invalidate()
    }
    previous.current = commands
  }, [commands])
  const refresh = useCallback(() => query.current?.invalidate(), [])
  return { setOpen, refresh }
}
