import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  mode = 'launch',
  disabled,
  onUse,
  value,
  onChange
}: {
  entry: AgentPickerEntry
  value?: AgentPickerDraft
  onChange?: (draft: AgentPickerDraft) => void
  initial?: AgentPickerDraft
  mode?: 'launch' | 'save' | 'create'
  disabled?: boolean
  onUse: (draft: AgentPickerDraft) => void
}) {
  const [localDraft, setLocalDraft] = useState(() => initial ?? agentPickerDraft(entry))
  const draft = value ?? localDraft
  const setDraft = (next: AgentPickerDraft) => {
    setLocalDraft(next)
    onChange?.(next)
  }
  const effective = agentPickerEffectiveChoices(entry, draft)
  const models = agentPickerModels(entry)
  const currentModel = effective.model
  const options = agentPickerEntryOptions(entry, currentModel, draft.surface)
  const showArguments = draft.surface === 'terminal' || mode === 'launch'
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
          use(mode === 'save' ? draft.surface : entry.defaultSurface)
        }
      }}
    >
      {mode === 'save' && entry.surfaces.length > 1 ? (
        <div
          className="flex gap-2"
          role="radiogroup"
          aria-label={translate('agentPicker.openAs', 'Open as')}
        >
          {entry.surfaces.map((surface) => (
            <Button
              key={surface}
              type="button"
              disabled={disabled}
              role="radio"
              aria-checked={draft.surface === surface}
              variant={draft.surface === surface ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setDraft({ ...draft, surface })}
            >
              {surface === 'chat'
                ? translate('agentPicker.chat', 'Chat')
                : translate('agentPicker.terminal', 'Terminal')}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="space-y-1">
        <Label>{translate('agentPicker.model', 'Model')}</Label>
        <Select
          disabled={disabled}
          value={draft.choices.model ?? DEFAULT}
          onValueChange={(model) =>
            setDraft(editAgentPickerDraft(draft, { model: model === DEFAULT ? null : model }))
          }
        >
          <SelectTrigger>
            <SelectValue placeholder={translate('agentPicker.agentDefault', 'Agent default')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>
              {translate('agentPicker.agentDefault', 'Agent default')}
              {currentModel && !draft.choices.model
                ? ` · ${models.find((model) => model.id === currentModel)?.label ?? currentModel}`
                : ''}
            </SelectItem>
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
            {draft.choices.model && !models.some((model) => model.id === draft.choices.model) ? (
              <SelectItem value={draft.choices.model}>{draft.choices.model}</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </div>
      {options.map((option) => {
        const choices =
          option.kind.type === 'select'
            ? option.kind.choices
            : [
                { value: 'true', label: translate('agentPicker.on', 'On') },
                { value: 'false', label: translate('agentPicker.off', 'Off') }
              ]
        const current = draft.choices.options?.[option.id]
        return (
          <div key={option.id} className="space-y-1">
            <Label>
              {option.label}
              {mode === 'launch' &&
              !agentPickerEntryOptions(entry, currentModel, 'terminal').some(
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
              {effective.permissionMode
                ? ` · ${translate(`agentPicker.permission.${effective.permissionMode}`, permissionLabels[effective.permissionMode])}`
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
      {showArguments ? (
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
        {mode === 'save' ? (
          <Button type="button" size="sm" disabled={disabled} onClick={() => use(draft.surface)}>
            {translate('agentPicker.use', 'Use')}
          </Button>
        ) : (
          agentPickerButtonOrder(entry).map((surface) => (
            <Button
              key={surface}
              type="button"
              size="sm"
              disabled={disabled}
              variant={surface === entry.defaultSurface ? 'default' : 'outline'}
              onClick={() => use(surface)}
            >
              {mode === 'create'
                ? surface === 'chat'
                  ? translate('agentPicker.createChat', 'Create and open chat')
                  : translate('agentPicker.createTerminal', 'Create and open terminal')
                : surface === 'chat'
                  ? translate('agentPicker.openChat', 'Open chat')
                  : translate('agentPicker.openTerminal', 'Open terminal')}
            </Button>
          ))
        )}
      </div>
    </div>
  )
}
