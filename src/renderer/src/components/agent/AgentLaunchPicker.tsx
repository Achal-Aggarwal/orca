import { useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { AgentDefaultContextMenu } from './agent-combobox-items'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import {
  agentPickerDraft,
  searchAgentPickerSetups,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

export function AgentLaunchPicker({
  entries,
  value,
  disabled,
  onUse,
  emptyLabel,
  onEmpty,
  mode = 'save',
  onOpenChange,
  onSetDefault,
  defaultAgent,
  onManage,
  onClear,
  triggerClassName,
  onTriggerEnter,
  onSelectAgent
}: {
  entries: AgentPickerEntry[]
  value?: AgentPickerDraft
  disabled?: boolean
  onUse: (draft: AgentPickerDraft) => void
  emptyLabel?: string
  onEmpty?: () => void
  mode?: 'save' | 'create'
  onOpenChange?: (open: boolean) => void
  onSetDefault?: (agent: TuiAgent | 'blank' | null) => void
  defaultAgent?: TuiAgent | 'blank' | null
  onManage?: () => void
  onClear?: () => void
  triggerClassName?: string
  onSelectAgent?: (agent: TuiAgent) => void
  onTriggerEnter?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(value?.agent)
  const [query, setQuery] = useState('')
  const [drafts, setDrafts] = useState<Partial<Record<TuiAgent, AgentPickerDraft>>>({})
  const pick = selected
    ? (drafts[selected] ?? (value?.agent === selected ? value : undefined))
    : undefined
  const setPick = (draft: AgentPickerDraft) =>
    setDrafts((current) => ({ ...current, [draft.agent]: draft }))
  const entry = entries.find((entry) => entry.agent === selected)
  const setups = searchAgentPickerSetups(entries, query)
  const use = (draft: AgentPickerDraft) => {
    onUse(draft)
    setOpen(false)
    onOpenChange?.(false)
  }
  const current = entries.find((entry) => entry.agent === value?.agent)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        onOpenChange?.(next)
        if (next) {
          setSelected(value?.agent ?? entries[0]?.agent)
          setDrafts({})
          setQuery('')
        }
      }}
    >
      <AgentDefaultContextMenu
        isDefault={Boolean(value && value.agent === defaultAgent)}
        onSetDefault={value && onSetDefault ? () => onSetDefault(value.agent) : undefined}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className={`w-full justify-between text-xs ${triggerClassName ?? ''}`}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && onTriggerEnter) {
                event.preventDefault()
                onTriggerEnter()
              }
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              {value ? <AgentIcon agent={value.agent} size={14} /> : null}
              {[
                current?.label ??
                  (value ? formatAgentTypeLabel(value.agent) : undefined) ??
                  emptyLabel ??
                  translate('agentPicker.selectAgent', 'Select an agent'),
                value?.choices.model
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <ChevronsUpDown className="size-3.5" />
          </Button>
        </PopoverTrigger>
      </AgentDefaultContextMenu>
      <PopoverContent align="start" className="flex w-auto max-w-[calc(100vw-2rem)] p-0">
        <div className="w-44 shrink-0 border-r border-border p-2">
          <Input
            value={query}
            placeholder={translate('agentPicker.search', 'Search agents and setups…')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="scrollbar-sleek mt-2 max-h-80 overflow-y-auto">
            {setups.map((setup) => (
              <Button
                key={`${setup.entry.agent}:${setup.model.id}:${setup.choices.options?.effort ?? ''}`}
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start whitespace-normal text-left text-xs"
                onClick={() => {
                  onSelectAgent?.(setup.entry.agent)
                  setSelected(setup.entry.agent)
                  setPick({
                    agent: setup.entry.agent,
                    surface: value?.surface ?? setup.entry.defaultSurface,
                    choices: setup.choices
                  })
                }}
              >
                {setup.label}
              </Button>
            ))}
            {entries
              .filter((entry) =>
                `${entry.agent} ${entry.label}`.toLowerCase().includes(query.toLowerCase())
              )
              .map((entry) => (
                <Button
                  key={entry.agent}
                  type="button"
                  variant="ghost"
                  data-current={selected === entry.agent}
                  className="w-full justify-start text-xs data-[current=true]:bg-accent"
                  onClick={() => {
                    onSelectAgent?.(entry.agent)
                    setSelected(entry.agent)
                    if (!drafts[entry.agent]) {
                      setPick(value?.agent === entry.agent ? value : agentPickerDraft(entry))
                    }
                  }}
                >
                  <AgentDefaultContextMenu
                    isDefault={entry.agent === defaultAgent}
                    onSetDefault={onSetDefault ? () => onSetDefault(entry.agent) : undefined}
                  >
                    <span className="flex w-full items-center gap-2">
                      <AgentIcon agent={entry.agent} size={14} />
                      {entry.label}
                    </span>
                  </AgentDefaultContextMenu>
                </Button>
              ))}
            {onClear ? (
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start text-xs"
                onClick={() => {
                  onClear()
                  setOpen(false)
                  onOpenChange?.(false)
                }}
              >
                {translate('components.agentCombobox.clearSelection', 'Clear agent selection')}
              </Button>
            ) : null}
            {onManage ? (
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start text-xs"
                onClick={onManage}
              >
                {translate('auto.components.agent.AgentCombobox.19522e25ee', 'Manage agents')}
              </Button>
            ) : null}
            {onEmpty ? (
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start text-xs"
                onClick={() => {
                  onEmpty()
                  setOpen(false)
                  onOpenChange?.(false)
                }}
              >
                {emptyLabel}
              </Button>
            ) : null}
          </div>
        </div>
        {entry ? (
          <AgentLaunchSetupPanel
            key={entry.agent}
            entry={entry}
            value={pick ?? agentPickerDraft(entry)}
            onChange={setPick}
            mode={mode}
            onUse={use}
          />
        ) : (
          <div className="w-96 p-3 text-sm text-muted-foreground">
            {translate('agentPicker.selectAgent', 'Select an agent')}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
