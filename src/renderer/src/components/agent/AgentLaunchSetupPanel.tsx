import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem
} from '@/components/ui/command'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { AgentArgsChoiceChips } from '../settings/AgentPermissionChoiceControls'
import { agentPickerArgumentPermission } from '../../../../shared/agent-launch-picker-permission'
import {
  agentPickerButtonOrder,
  agentPickerDraft,
  agentPickerEffectiveChoices,
  agentPickerModels,
  agentPickerEntryOptions,
  agentPickerPermissions,
  editAgentPickerArguments,
  editAgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerDraft,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

const DEFAULT = '__agent_default__'
const permissionLabels = {
  own: 'Use agent configuration',
  ask: 'Ask',
  'accept-edits': 'Accept edits',
  auto: 'Approve for me',
  'full-access': 'Full access'
}

export function AgentLaunchSetupPanel({
  entry,
  initial,
  disabled,
  onUse
}: {
  entry: AgentPickerEntry
  initial?: AgentPickerDraft
  disabled?: boolean
  onUse: (draft: AgentPickerDraft) => void
}) {
  const [draft, setDraft] = useState(() => initial ?? agentPickerDraft(entry))
  const [modelQuery, setModelQuery] = useState('')
  const [legacy, setLegacy] = useState(false)
  const effective = agentPickerEffectiveChoices(entry, draft)
  const defaults = agentPickerEffectiveChoices(entry, { ...draft, choices: {} })
  const models = agentPickerModels(entry)
  const currentModel = effective.model
  const terminalArguments = draft.surface === 'terminal' && draft.arguments !== undefined
  const selectedModel = terminalArguments ? currentModel : draft.choices.model
  const options = agentPickerEntryOptions(entry, currentModel, draft.surface)
  const argumentPermission = agentPickerArgumentPermission(entry, draft)
  const permissionOwnedByArguments = argumentPermission?.locked ? argumentPermission : undefined
  const use = (surface: AgentPickerSurface) => onUse({ ...draft, surface })
  return (
    <div
      className="w-96 max-w-full space-y-3 p-3"
      onKeyDown={(event) => {
        event.stopPropagation()
        if (!disabled && event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault()
          use(entry.defaultSurface)
        }
      }}
    >
      <div className="space-y-1">
        <Label>{translate('agentPicker.model', 'Model')}</Label>
        <Command
          density="menu"
          onKeyDownCapture={(event) => {
            if (
              !disabled &&
              event.key === 'Enter' &&
              event.currentTarget.querySelector(
                '[cmdk-item][data-selected="true"][data-current="true"]'
              )
            ) {
              event.preventDefault()
              event.stopPropagation()
              use(entry.defaultSurface)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.stopPropagation()
            }
          }}
        >
          <CommandInput
            disabled={disabled}
            value={modelQuery}
            onValueChange={setModelQuery}
            aria-label={translate('agentPicker.searchModels', 'Search models')}
            placeholder={translate('agentPicker.searchModels', 'Search models')}
          />
          <CommandList className="h-48 scrollbar-sleek">
            <CommandEmpty>
              {translate('agentPicker.noModels', 'No models match your search.')}
            </CommandEmpty>
            <CommandItem
              disabled={disabled}
              value={DEFAULT}
              keywords={[translate('agentPicker.agentDefault', 'Agent default')]}
              data-current={!selectedModel}
              onSelect={() => setDraft(editAgentPickerDraft(draft, { model: null }))}
            >
              {translate('agentPicker.agentDefault', 'Agent default')}
              {currentModel && !selectedModel
                ? ` · ${models.find((model) => model.id === currentModel)?.label ?? currentModel}`
                : ''}
            </CommandItem>
            {legacy && !modelQuery ? (
              <CommandItem value="__back__" disabled={disabled} onSelect={() => setLegacy(false)}>
                {translate('agentPicker.backModels', 'Back to current models')}
              </CommandItem>
            ) : null}
            {models
              .filter(
                (model) => !model.hidden && (modelQuery || Boolean(model.isLegacy) === legacy)
              )
              .map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.label]}
                  disabled={disabled}
                  data-current={selectedModel === model.id}
                  onSelect={() => setDraft(editAgentPickerDraft(draft, { model: model.id }))}
                >
                  {model.label}
                </CommandItem>
              ))}
            {!legacy && !modelQuery && models.some((model) => model.isLegacy) ? (
              <CommandItem value="__legacy__" disabled={disabled} onSelect={() => setLegacy(true)}>
                {translate('agentPicker.legacyModels', 'Legacy models')}
              </CommandItem>
            ) : null}
            {selectedModel && !models.some((model) => model.id === selectedModel) ? (
              <CommandItem
                value={selectedModel}
                disabled={disabled}
                onSelect={() => {}}
                data-current="true"
              >
                {selectedModel}
              </CommandItem>
            ) : null}
          </CommandList>
        </Command>
      </div>
      {options.map((option) => {
        const choices =
          option.kind.type === 'select'
            ? option.kind.choices
            : [
                { value: 'true', label: translate('agentPicker.on', 'On') },
                { value: 'false', label: translate('agentPicker.off', 'Off') }
              ]
        const current = (terminalArguments ? effective : draft.choices).options?.[option.id]
        return (
          <div key={option.id} className="space-y-1">
            <Label>
              {option.label}
              {!agentPickerEntryOptions(entry, currentModel, 'terminal').some(
                (terminal) => terminal.id === option.id
              )
                ? ` · ${translate('agentPicker.chatOnly', 'Chat only')}`
                : ''}
            </Label>
            <Select
              disabled={disabled}
              value={current ?? DEFAULT}
              onValueChange={(value) =>
                setDraft(
                  editAgentPickerDraft(draft, {
                    options: { [option.id]: value === DEFAULT ? null : value }
                  })
                )
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>
                  {translate('agentPicker.default', 'Default')}
                  {defaults.options?.[option.id]
                    ? ` · ${choices.find((choice) => choice.value === defaults.options?.[option.id])?.label ?? defaults.options[option.id]}`
                    : ''}
                </SelectItem>
                {choices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
                {current && !choices.some((choice) => choice.value === current) ? (
                  <SelectItem value={current}>{current}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>
        )
      })}
      <div className="space-y-1">
        <Label>{translate('agentPicker.permissions', 'Permissions')}</Label>
        <Select
          disabled={disabled || Boolean(permissionOwnedByArguments)}
          value={
            permissionOwnedByArguments ? '__arguments__' : (draft.choices.permissionMode ?? DEFAULT)
          }
          onValueChange={(permissionMode) => {
            const choice = agentPickerPermissions(entry.agent, draft.surface).find(
              (choice) => choice === permissionMode
            )
            setDraft(editAgentPickerDraft(draft, { permissionMode: choice ?? 'default' }))
          }}
        >
          <SelectTrigger aria-label={translate('agentPicker.permissions', 'Permissions')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {permissionOwnedByArguments ? (
              <SelectItem value="__arguments__">{permissionOwnedByArguments.flag}</SelectItem>
            ) : null}
            <SelectItem value={DEFAULT}>
              {translate('agentPicker.agentsDefaults', 'Agents defaults')}
              {defaults.permissionMode
                ? ` · ${translate(`agentPicker.permission.${defaults.permissionMode}`, permissionLabels[defaults.permissionMode])}`
                : ''}
            </SelectItem>
            {agentPickerPermissions(entry.agent, draft.surface).map((choice) => (
              <SelectItem key={choice} value={choice}>
                {translate(`agentPicker.permission.${choice}`, permissionLabels[choice])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {entry.surfaces.includes('terminal') ? (
        <div className="space-y-1">
          <Label htmlFor={`agent-arguments-${entry.agent}`}>
            {translate('agentPicker.arguments', 'Arguments')}
          </Label>
          {argumentPermission ? (
            <div className="pb-5">
              <AgentArgsChoiceChips
                disabled={disabled}
                chips={[
                  {
                    key: 'permissionMode',
                    label: entry.label,
                    source: 'arguments',
                    flag: argumentPermission.flag,
                    onRemove: () => argumentPermission.remainingArguments
                  }
                ]}
                onRemove={() =>
                  setDraft(editAgentPickerArguments(draft, argumentPermission.remainingArguments))
                }
              />
            </div>
          ) : null}
          <Input
            id={`agent-arguments-${entry.agent}`}
            className="font-mono text-xs"
            disabled={disabled}
            value={
              argumentPermission?.remainingArguments ??
              (draft.arguments === undefined ? (entry.arguments ?? '') : (draft.arguments ?? ''))
            }
            onChange={(event) =>
              setDraft(
                editAgentPickerArguments(
                  draft,
                  [argumentPermission?.flag, event.target.value].filter(Boolean).join(' ')
                )
              )
            }
          />
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {translate('agentPicker.argumentsHint', 'Applies only to CLI launches.')}
              {draft.arguments === undefined
                ? ` ${translate('agentPicker.agentsDefaults', 'Agents defaults')}`
                : ''}
            </span>
            {draft.arguments !== undefined ? (
              <Button
                type="button"
                disabled={disabled}
                variant="link"
                size="xs"
                onClick={() => setDraft({ ...draft, arguments: undefined })}
              >
                {translate('agentPicker.resetArguments', 'Reset to default')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        {agentPickerButtonOrder(entry).map((surface) => (
          <Button
            key={surface}
            type="button"
            size="sm"
            disabled={disabled}
            variant={surface === entry.defaultSurface ? 'default' : 'outline'}
            onClick={() => use(surface)}
          >
            {surface === 'chat'
              ? translate('agentPicker.openChat', 'Open chat')
              : translate('agentPicker.openTerminal', 'Open terminal')}
          </Button>
        ))}
      </div>
    </div>
  )
}
