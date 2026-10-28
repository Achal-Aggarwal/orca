import type { AgentPermissionChoice } from '../../../../shared/tui-agent-permission-choice'
import type { AgentPermissionChoiceRow } from './AgentPermissionChoiceControls'
import { cn } from '@/lib/utils'
import { nativeChatPermissionModeDescription } from '../native-chat/native-chat-permission-mode-labels'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '../ui/dropdown-menu'

export function AgentPermissionMenuOptions({
  agentId,
  permission,
  disabled,
  rawValue,
  showInherited,
  followAll,
  choiceLabel,
  ownDescription
}: {
  agentId: string
  permission: AgentPermissionChoiceRow
  disabled?: boolean
  rawValue?: string
  showInherited: boolean
  followAll: string
  choiceLabel: (choice: AgentPermissionChoice) => string
  ownDescription: string
}) {
  return (
    <DropdownMenuRadioGroup
      value={
        rawValue ? `raw:${rawValue}` : permission.source === 'all' ? 'default' : permission.choice
      }
    >
      {showInherited ? (
        <>
          <DropdownMenuRadioItem
            value="default"
            disabled={disabled}
            onSelect={() => permission.onSelect('default')}
          >
            <span className="truncate">
              {followAll} · {choiceLabel(permission.defaultChoice)}
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
        </>
      ) : null}
      {rawValue ? (
        <DropdownMenuRadioItem value={`raw:${rawValue}`}>{rawValue}</DropdownMenuRadioItem>
      ) : null}
      {permission.choices.map((choice) => (
        <DropdownMenuRadioItem
          key={choice}
          value={choice}
          disabled={disabled}
          onSelect={() => permission.onSelect(choice)}
        >
          <div className="min-w-0 py-0.5">
            <div className={cn(choice === 'full-access' && 'text-status-warning')}>
              {choiceLabel(choice)}
            </div>
            <div className="text-xs font-normal text-muted-foreground">
              {choice === 'own'
                ? ownDescription
                : nativeChatPermissionModeDescription(choice, agentId)}
            </div>
          </div>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}
