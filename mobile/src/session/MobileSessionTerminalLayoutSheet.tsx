import { Check, Columns2, LayoutGrid, Rows2, SquareTerminal } from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import type { TerminalSplitLayout } from '../storage/preferences'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileSessionTerminalLayoutSheet({
  controller,
  visible,
  onClose
}: {
  controller: MobileSessionController
  visible: boolean
  onClose: () => void
}) {
  const {
    canSplitTerminals,
    terminalSplitActive,
    toggleTerminalSplit,
    terminalSplitLayout,
    setTerminalSplitLayout
  } = controller
  const chooseSplitLayout = (layout: TerminalSplitLayout) => {
    setTerminalSplitLayout(layout)
    if (!terminalSplitActive) {
      toggleTerminalSplit()
    }
  }
  return (
    <ActionSheetModal
      visible={visible}
      title="Terminal layout"
      onClose={onClose}
      actions={[
        {
          label: 'One terminal',
          icon: terminalSplitActive ? SquareTerminal : Check,
          hint: !terminalSplitActive ? 'Selected' : undefined,
          onPress: () => {
            if (terminalSplitActive) {
              toggleTerminalSplit()
            }
          }
        },
        ...(
          [
            {
              layout: 'auto',
              label: 'Auto',
              icon: LayoutGrid,
              hint: 'Split to fit the available space'
            },
            {
              layout: 'side-by-side',
              label: 'Side by side',
              icon: Columns2,
              hint: 'Two columns, even with the sidebar open'
            },
            {
              layout: 'stacked',
              label: 'Stacked',
              icon: Rows2,
              hint: 'Two rows in any orientation'
            }
          ] as const
        ).map(({ layout, label, icon, hint }) => ({
          label,
          icon: terminalSplitActive && terminalSplitLayout === layout ? Check : icon,
          hint: terminalSplitActive && terminalSplitLayout === layout ? `Selected · ${hint}` : hint,
          disabled: !canSplitTerminals && !terminalSplitActive,
          onPress: () => chooseSplitLayout(layout)
        }))
      ]}
    />
  )
}
