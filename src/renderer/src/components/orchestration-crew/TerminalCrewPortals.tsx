import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { TerminalPaneController } from '../terminal-pane/use-terminal-pane-controller'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { useTerminalCrewIdentity } from './use-terminal-crew-identity'
import { OrchestrationCrewPanel } from './OrchestrationCrewPanel'

function TerminalCrewPortal({
  pane,
  controller
}: {
  pane: ManagedPane
  controller: TerminalPaneController
}) {
  const { tabId, worktreeId, paneTransportsRef } = controller
  const paneKey = makePaneKey(tabId, pane.leafId)
  const boundPtyId = useAppStore(
    (state) => state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[pane.leafId] ?? null
  )
  const transport = paneTransportsRef.current.get(pane.id)
  const { target, party } = useTerminalCrewIdentity(
    paneKey,
    transport?.getPtyId() ?? boundPtyId,
    worktreeId
  )
  if (!target || !party || !transport) {
    return null
  }
  return createPortal(
    <OrchestrationCrewPanel target={target} party={party} />,
    pane.container,
    `crew-${pane.id}`
  )
}
export function TerminalCrewPortals({ controller }: { controller: TerminalPaneController }) {
  return (
    <>
      {controller.managedPanes.map((pane) =>
        controller.effectiveChatViewMode && controller.chatPane?.id === pane.id ? null : (
          <TerminalCrewPortal key={pane.id} pane={pane} controller={controller} />
        )
      )}
    </>
  )
}
