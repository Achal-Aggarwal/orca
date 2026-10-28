import { useRef, useState, type KeyboardEvent } from 'react'
import { ChevronRight, MessageSquare, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import { chatUnavailableLabel } from '../tab-bar/tab-agent-row-presentation'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch-picker-rows'
import {
  searchAgentPickerSetups,
  agentPickerButtonOrder,
  type AgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerSetup,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

function pickerButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.click()
  } else if (['ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    event.stopPropagation()
    const row = event.currentTarget.closest<HTMLElement>('[role="menuitem"]')
    row?.focus()
    if (event.key !== 'ArrowLeft') {
      row?.dispatchEvent(new window.KeyboardEvent('keydown', { key: event.key, bubbles: true }))
    }
  }
}

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

type Launch = (row: NewTabAgentMenuRow, draft?: AgentPickerDraft, entry?: AgentPickerEntry) => void

export function AgentLaunchPickerMenu({
  model,
  disabled,
  runLaunch,
  entries,
  hideSearch,
  onSelectAgent
}: {
  model: NewTabAgentMenuModel
  disabled?: boolean
  runLaunch: Launch
  entries: AgentPickerEntry[]
  hideSearch?: boolean
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
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
      {visible.map((entry) => (
        <AgentPickerMenuRow
          key={entry.agent}
          entry={entry}
          disabled={disabled}
          runLaunch={runLaunch}
          onSelectAgent={onSelectAgent}
          shortcut={
            model.state === 'settled' && model.defaultTuiAgent === entry.agent
              ? (shortcut ?? undefined)
              : undefined
          }
        />
      ))}
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
            onKeyDown={pickerButtonKeyDown}
          >
            {surface === 'chat' ? <MessageSquare /> : <Terminal />}
          </Button>
        ))}
    </DropdownMenuItem>
  )
}

function AgentPickerMenuRow({
  entry,
  disabled,
  runLaunch,
  shortcut,
  onSelectAgent
}: {
  entry: AgentPickerEntry
  disabled?: boolean
  runLaunch: Launch
  shortcut?: string
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
  const [open, setOpen] = useState(false)
  const item = useRef<HTMLDivElement>(null)
  const chevron = useRef<HTMLButtonElement>(null)
  const configured = useRef<AgentPickerDraft | undefined>(undefined)
  const selectedSurface = useRef<AgentPickerSurface | undefined>(undefined)
  const unavailable = entry.rows.find((row) => row.kind === 'chat-unavailable')
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
        disabled={disabled || !entry.surfaces.length}
        onSelect={(event) => {
          if (open && !configured.current) {
            event.preventDefault()
            return
          }
          const draft = configured.current
          configured.current = undefined
          const surface = selectedSurface.current ?? entry.defaultSurface
          selectedSurface.current = undefined
          const row = draft
            ? pickerLaunchRow(entry, draft.surface)
            : (entry.rows.find((row) =>
                surface === 'chat'
                  ? row.kind === 'chat'
                  : row.kind === 'terminal' || row.kind === 'cli'
              ) ?? pickerLaunchRow(entry, surface))
          if (draft) {
            runLaunch(row, draft, entry)
          } else {
            runLaunch(row, draft)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            chevron.current?.focus()
          }
        }}
      >
        <AgentIcon agent={entry.agent} size={14} />
        <span className="flex-1">{entry.label}</span>
        {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
        {unavailable?.kind === 'chat-unavailable' && !entry.surfaces.includes('chat') ? (
          <span className="text-xs text-muted-foreground">
            {chatUnavailableLabel(unavailable.reason)}
          </span>
        ) : null}
        {agentPickerButtonOrder(entry).map((surface) => (
          <Button
            key={surface}
            type="button"
            size="xs"
            variant={surface === entry.defaultSurface ? 'secondary' : 'ghost'}
            disabled={disabled}
            aria-label={
              surface === 'chat'
                ? translate('agentPicker.openChat', 'Open chat')
                : translate('agentPicker.openTerminal', 'Open terminal')
            }
            onClick={() => {
              selectedSurface.current = surface
            }}
            onKeyDown={pickerButtonKeyDown}
          >
            {surface === 'chat'
              ? translate('agentPicker.chat', 'Chat')
              : translate('agentPicker.terminal', 'Terminal')}
          </Button>
        ))}
        <PopoverTrigger asChild>
          <Button
            ref={chevron}
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={disabled || entry.defaultsPending}
            aria-label={translate('agentPicker.configure', 'Configure {{agent}}', {
              agent: entry.label
            })}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={pickerButtonKeyDown}
          >
            <ChevronRight />
          </Button>
        </PopoverTrigger>
      </DropdownMenuItem>
      <PopoverContent
        side="right"
        align="start"
        className="w-auto p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <AgentLaunchSetupPanel
          key={entry.agent}
          entry={entry}
          disabled={disabled || entry.defaultsPending}
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
