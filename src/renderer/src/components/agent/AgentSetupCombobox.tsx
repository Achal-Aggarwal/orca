import { useState } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { resolveAgentChoiceLayers } from '../../../../shared/agent-choice-layers'
import { AgentLaunchPicker } from './AgentLaunchPicker'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import type { AgentComboboxProps } from './AgentCombobox'

export function SetupAgentCombobox(props: AgentComboboxProps): React.JSX.Element {
  const rows = props.surfaceRows
  const [selected, setSelected] = useState<TuiAgent | undefined>(props.value ?? undefined)
  const [open, setOpen] = useState(false)
  const inventory = useAgentLaunchPickerInventory(
    rows?.worktreeId,
    rows?.model ?? { state: 'loading', placeholderCount: 2 },
    open,
    selected
  )
  const entries = inventory.map((entry) => {
    const defaults = rows?.setupDefaults
    if (defaults?.agent !== entry.agent) {
      return entry
    }
    const layer = (base: typeof entry.terminal) =>
      resolveAgentChoiceLayers({
        agent: entry.agent,
        defaults: base,
        action: defaults.choices,
        argumentOwner: 'defaults'
      })
    return {
      ...entry,
      terminal: layer(entry.terminal),
      structured: layer(entry.structured),
      ...(defaults.arguments !== undefined ? { arguments: defaults.arguments } : {})
    }
  })
  const current = entries.find((entry) => entry.agent === props.value)
  return (
    <AgentLaunchPicker
      mode={rows?.pickerMode}
      entries={entries}
      onSelectAgent={setSelected}
      value={
        props.clearSelection?.cleared
          ? undefined
          : (rows?.setup ??
            (props.value
              ? {
                  agent: props.value,
                  surface: rows?.surface ?? current?.defaultSurface ?? 'terminal',
                  choices: {}
                }
              : undefined))
      }
      disabled={props.disabled}
      emptyLabel={props.blankLabel}
      onEmpty={props.allowBlankTerminal ? () => props.onValueChange(null) : undefined}
      onUse={(draft) => rows?.onSetup?.(draft)}
      onOpenChange={setOpen}
      onSetDefault={props.onSetDefault}
      defaultAgent={props.defaultAgent}
      onManage={props.onOpenManageAgents}
      onClear={props.clearSelection?.onClear}
      triggerClassName={props.triggerClassName}
      onTriggerEnter={props.onTriggerEnter}
    />
  )
}
