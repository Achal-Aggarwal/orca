import { useState } from 'react'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { BottomDrawer } from '../components/BottomDrawer'
import { ActionSheetContent } from '../components/ActionSheetModal'
import { supportsMobilePickerSetup } from './new-tab-agent-host-launch'
import { MobileAgentLaunchPicker } from './MobileAgentLaunchPicker'
import { useMobileAgentPickerInventory } from './mobile-agent-picker-inventory'
import { FileText, Globe, SquareTerminal } from 'lucide-react-native'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileNewAgentSheet({
  controller,
  onPairedHost
}: {
  controller: MobileSessionController
  onPairedHost: boolean
}) {
  const [selectedPickerAgent, setSelectedPickerAgent] = useState<TuiAgent>()
  const pickerInventory = useMobileAgentPickerInventory({
    selected: selectedPickerAgent,
    client: controller.client,
    worktreeId: controller.worktreeId,
    hostCapabilities: controller.hostCapabilities,
    options: controller.createTabAgentOptions,
    connectionKey: JSON.stringify([
      controller.hostId,
      controller.clientId,
      controller.lastConnectedAt
    ]),
    open: controller.showCreateTabDrawer
  })
  const {
    showCreateTabDrawer,
    setShowCreateTabDrawer,
    createTabAgentActions,
    handleCreateTerminal,
    isFloatingWorkspaceRoute,
    browserScreencastSupported,
    showToast,
    setShowCreateBrowserModal,
    handleCreateMarkdownNote
  } = controller
  return (
    <BottomDrawer visible={showCreateTabDrawer} onClose={() => setShowCreateTabDrawer(false)}>
      <MobileAgentLaunchPicker
        key={JSON.stringify([
          controller.hostId,
          controller.worktreeId,
          controller.showCreateTabDrawer
        ])}
        entries={pickerInventory}
        onSelectAgent={setSelectedPickerAgent}
        setupSupported={supportsMobilePickerSetup(controller.hostCapabilities)}
        disabled={controller.creating}
        onUse={(draft) => {
          setShowCreateTabDrawer(false)
          void handleCreateTerminal(
            draft.agent,
            'choices' in draft ? { pickerSetup: draft } : undefined
          )
        }}
      />
      <ActionSheetContent
        title="New Tab"
        actions={[
          ...(pickerInventory.length ? [] : createTabAgentActions),
          {
            label: 'Terminal',
            icon: SquareTerminal,
            onPress: () => {
              setShowCreateTabDrawer(false)
              void handleCreateTerminal()
            }
          },
          // Why: browser/markdown creation resolve a real worktree on the host
          // (browser.tabCreate, files.createFile); the floating sentinel is
          // terminal-only over RPC, so those options hide there.
          ...(isFloatingWorkspaceRoute
            ? []
            : [
                {
                  label: 'Browser',
                  icon: Globe,
                  closeBeforePress: true,
                  onPress: () => {
                    if (browserScreencastSupported !== true) {
                      showToast('Desktop update required for mobile browser streaming', 1600)
                      return
                    }
                    setShowCreateBrowserModal(true)
                  }
                },
                ...(onPairedHost
                  ? [
                      {
                        label: 'Markdown Note',
                        icon: FileText,
                        onPress: () => {
                          setShowCreateTabDrawer(false)
                          void handleCreateMarkdownNote()
                        }
                      }
                    ]
                  : [])
              ])
        ]}
        onClose={() => setShowCreateTabDrawer(false)}
      />
    </BottomDrawer>
  )
}
