import { useRef, useState } from 'react'
import { ChevronRight, MessageSquare, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import { rowLabel, rowId, chatUnavailableLabel } from '../tab-bar/tab-agent-row-presentation'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch-picker-rows'
import {
  searchAgentPickerSetups,
  type AgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerSetup,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

export function pickerLaunchRow(
  entry: AgentPickerEntry,
  surface: AgentPickerSurface
): NewTabAgentMenuRow {
  return {
    agent: entry.agent,
    kind: surface === 'chat' ? 'chat' : 'cli',
    executionHostId: entry.rows[0]?.executionHostId
  }
}

type Launch = (row: NewTabAgentMenuRow, draft?: AgentPickerDraft) => void

export function AgentLaunchPickerMenu({
  model,
  worktreeId,
  disabled,
  runLaunch,
  entries: supplied,
  hideSearch,
  onSelectAgent
}: {
  model: NewTabAgentMenuModel
  worktreeId?: string
  disabled?: boolean
  runLaunch: Launch
  entries?: AgentPickerEntry[]
  hideSearch?: boolean
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
  const [selected, setSelected] = useState<AgentPickerEntry['agent']>()
  const inventory = useAgentLaunchPickerInventory(
    worktreeId,
    model,
    supplied === undefined,
    selected
  )
  const entries = supplied ?? inventory
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const shortcut = useOptionalShortcutLabel('tab.newAgent')
  const setups = searchAgentPickerSetups(entries, query)
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = entries.filter((entry) =>
    words.every((word) => `${entry.agent} ${entry.label}`.toLowerCase().includes(word))
  )
  return (
    <div ref={root} data-agent-launch-picker="true">
      {!hideSearch ? (
        <div className="p-1">
          <Input
            value={query}
            autoFocus
            placeholder={translate('agentPicker.search', 'Search agents and setups…')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                return
              }
              event.stopPropagation()
              if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault()
                const first = root.current?.querySelector<HTMLElement>(
                  '[role="menuitem"]:not([data-disabled])'
                )
                if (event.key === 'Enter') {
                  first?.click()
                } else {
                  first?.focus()
                }
              }
            }}
          />
        </div>
      ) : null}
      {setups.map((setup) => (
        <SetupMenuRow
          key={`${setup.entry.agent}:${setup.model.id}:${setup.choices.options?.effort ?? ''}`}
          setup={setup}
          disabled={disabled}
          runLaunch={runLaunch}
        />
      ))}
      {visible.flatMap((entry) =>
        entry.rows.map((row) => (
          <AgentPickerMenuRow
            key={rowId(row)}
            entry={entry}
            row={row}
            disabled={disabled}
            runLaunch={runLaunch}
            onSelectAgent={(agent) => {
              setSelected(agent)
              onSelectAgent?.(agent)
            }}
            shortcut={
              model.state === 'settled' && model.defaultTuiAgent === entry.agent
                ? (shortcut ?? undefined)
                : undefined
            }
          />
        ))
      )}
      {!visible.length && !setups.length ? (
        <DropdownMenuItem disabled>
          {translate(
            'auto.components.agent.AgentCombobox.579c768bde',
            'No agents match your search.'
          )}
        </DropdownMenuItem>
      ) : null}
    </div>
  )
}

function SetupMenuRow({
  setup,
  disabled,
  runLaunch
}: {
  setup: AgentPickerSetup
  disabled?: boolean
  runLaunch: Launch
}) {
  const alternate = useRef<AgentPickerSurface | undefined>(undefined)
  return (
    <DropdownMenuItem
      variant="launch"
      disabled={disabled}
      onSelect={() => {
        const surface = alternate.current ?? setup.entry.defaultSurface
        alternate.current = undefined
        runLaunch(pickerLaunchRow(setup.entry, surface), {
          agent: setup.entry.agent,
          surface,
          choices: setup.choices
        })
      }}
    >
      <AgentIcon agent={setup.entry.agent} size={14} />
      <span className="flex-1">{setup.label}</span>
      {setup.entry.surfaces
        .filter((surface) => surface !== setup.entry.defaultSurface)
        .slice(0, 1)
        .map((surface) => (
          <Button
            key={surface}
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={
              surface === 'chat'
                ? translate('agentPicker.openChat', 'Open chat')
                : translate('agentPicker.openTerminal', 'Open terminal')
            }
            onClick={() => {
              alternate.current = surface
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                event.stopPropagation()
                event.currentTarget.click()
              }
            }}
          >
            {surface === 'chat' ? <MessageSquare /> : <Terminal />}
          </Button>
        ))}
    </DropdownMenuItem>
  )
}

function AgentPickerMenuRow({
  entry,
  row,
  disabled,
  runLaunch,
  shortcut,
  onSelectAgent
}: {
  entry: AgentPickerEntry
  row: NewTabAgentMenuRow
  disabled?: boolean
  runLaunch: Launch
  shortcut?: string
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
  const [open, setOpen] = useState(false)
  const item = useRef<HTMLDivElement>(null)
  const chevron = useRef<HTMLButtonElement>(null)
  const configured = useRef<AgentPickerDraft | undefined>(undefined)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          onSelectAgent?.(entry.agent)
        }
      }}
    >
      <DropdownMenuItem
        ref={item}
        variant="launch"
        disabled={disabled || row.kind === 'chat-unavailable'}
        onSelect={(event) => {
          if (open && !configured.current) {
            event.preventDefault()
            return
          }
          const draft = configured.current
          configured.current = undefined
          runLaunch(draft ? pickerLaunchRow(entry, draft.surface) : row, draft)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            chevron.current?.focus()
          }
        }}
      >
        <AgentIcon agent={row.agent} size={14} />
        <span className="flex-1">{rowLabel(row)}</span>
        {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
        {row.kind === 'chat-unavailable' ? (
          <span className="text-muted-foreground">{chatUnavailableLabel(row.reason)}</span>
        ) : (
          <PopoverTrigger asChild>
            <Button
              ref={chevron}
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate('agentPicker.configure', 'Configure {{agent}}', {
                agent: entry.label
              })}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  event.currentTarget.click()
                }
              }}
            >
              <ChevronRight />
            </Button>
          </PopoverTrigger>
        )}
      </DropdownMenuItem>
      <PopoverContent
        side="right"
        align="start"
        className="w-auto p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <AgentLaunchSetupPanel
          entry={entry}
          onUse={(draft) => {
            configured.current = draft
            item.current?.click()
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
