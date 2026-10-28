import { useState } from 'react'
import { Check } from 'lucide-react'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session-option-catalog'
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
  const models = agentPickerModels(entry)
  const defaultsPending =
    entry.defaultsPending || (draft.surface === 'chat' && entry.structuredDefaultsPending)
  const seed = getAgentSessionOptionLaunchCatalog(entry.agent)
  const listedDefaultKnown =
    entry.catalog.origin !== 'unknown' &&
    (entry.catalog.listingNamesConfiguredModel ?? seed?.hostListingNamesConfiguredModel === true)
  const currentModel =
    effective.model ??
    (!defaultsPending && listedDefaultKnown
      ? models.find((model) => model.isDefault)?.id
      : undefined)
  const modelDisabled = disabled || defaultsPending || !currentModel
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
            disabled={modelDisabled}
            value={modelQuery}
            onValueChange={setModelQuery}
            aria-label={translate('agentPicker.searchModels', 'Search models')}
            placeholder={translate('agentPicker.searchModels', 'Search models')}
          />
          <CommandList className="h-48 scrollbar-sleek">
            <CommandEmpty>
              {translate('agentPicker.noModels', 'No models match your search.')}
            </CommandEmpty>
            {legacy && !modelQuery ? (
              <CommandItem value="__back__" disabled={disabled} onSelect={() => setLegacy(false)}>
                {translate('agentPicker.backModels', 'Back to current models')}
              </CommandItem>
            ) : null}
            {models
              .filter(
                (model) =>
                  !model.hidden &&
                  (model.id === currentModel || modelQuery || Boolean(model.isLegacy) === legacy)
              )
              .map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.label]}
                  disabled={modelDisabled}
                  data-current={currentModel === model.id}
                  onSelect={() => setDraft(editAgentPickerDraft(draft, { model: model.id }))}
                >
                  {model.label}
                  {currentModel === model.id ? <Check className="ml-auto size-3.5" /> : null}
                </CommandItem>
              ))}
            {!legacy && !modelQuery && models.some((model) => model.isLegacy) ? (
              <CommandItem value="__legacy__" disabled={disabled} onSelect={() => setLegacy(true)}>
                {translate('agentPicker.legacyModels', 'Legacy models')}
              </CommandItem>
            ) : null}
            {currentModel && !models.some((model) => model.id === currentModel) ? (
              <CommandItem
                value={currentModel}
                disabled={modelDisabled}
                onSelect={() => {}}
                data-current="true"
              >
                {currentModel}
                <Check className="ml-auto size-3.5" />
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
        const liveModel = models.find((model) => model.id === currentModel)
        const current =
          effective.options?.[option.id] ??
          (currentModel && !defaultsPending
            ? option.kind.type === 'boolean'
              ? String(option.kind.defaultValue)
              : option.id === 'effort'
                ? liveModel?.defaultEffort
                : option.kind.defaultIsCliDefault
                  ? option.kind.defaultValue
                  : undefined
            : undefined)
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
              disabled={disabled || defaultsPending || current === undefined}
              value={current ?? ''}
              onValueChange={(value) =>
                setDraft(
                  editAgentPickerDraft(draft, {
                    options: { [option.id]: value }
                  })
                )
              }
            >
              <SelectTrigger aria-label={option.label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
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
          disabled={
            disabled ||
            defaultsPending ||
            Boolean(permissionOwnedByArguments) ||
            !effective.permissionMode
          }
          value={permissionOwnedByArguments ? '__arguments__' : (effective.permissionMode ?? '')}
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
                disabled={disabled || entry.defaultsPending}
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
            disabled={disabled || entry.defaultsPending}
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
          <p className="text-xs text-muted-foreground">
            {translate('agentPicker.argumentsHint', 'Applies only to CLI launches.')}
          </p>
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
