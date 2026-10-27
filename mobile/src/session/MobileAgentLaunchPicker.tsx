import { useState } from 'react'
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { MobileAgentPickerPermissionFields } from './MobileAgentPickerPermissionFields'
import { colors, spacing, typography, radii } from '../theme/mobile-theme'
import {
  agentPickerDraft,
  agentPickerModels,
  agentPickerEffectiveChoices,
  agentPickerEntryOptions,
  agentPickerButtonOrder,
  searchAgentPickerSetups,
  editAgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerDraft
} from '../../../src/shared/agent-launch-picker'

export function MobileAgentLaunchPicker({
  entries,
  initial,
  mode = 'launch',
  disabled,
  setupSupported = true,
  onSelectAgent,
  onUse
}: {
  entries: AgentPickerEntry[]
  initial?: AgentPickerDraft
  mode?: 'launch' | 'save'
  disabled?: boolean
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
  setupSupported?: boolean
  onUse: (draft: AgentPickerDraft | { agent: AgentPickerEntry['agent'] }) => void
}) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<AgentPickerDraft | undefined>(initial)
  const entry = entries.find((entry) => entry.agent === draft?.agent)
  const setups = setupSupported ? searchAgentPickerSetups(entries, query) : []
  if (draft && entry) {
    const effective = agentPickerEffectiveChoices(entry, draft)
    const options = agentPickerEntryOptions(entry, effective.model, draft.surface)
    const models = agentPickerModels(entry)
    return (
      <View style={styles.panel}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to agents"
          style={styles.back}
          disabled={disabled}
          onPress={() => setDraft(undefined)}
        >
          <ChevronLeft size={16} color={colors.textPrimary} />
          <Text style={styles.text}>Agents</Text>
        </Pressable>
        {mode === 'save' ? (
          <View style={styles.options}>
            {entry.surfaces.map((surface) => (
              <Choice
                disabled={disabled}
                key={surface}
                label={surface === 'chat' ? 'Chat' : 'Terminal'}
                selected={draft.surface === surface}
                onPress={() => setDraft({ ...draft, surface })}
              />
            ))}
          </View>
        ) : null}
        <Text style={styles.label}>Model</Text>
        <Choice
          disabled={disabled}
          label={`Agent default${effective.model && !draft.choices.model ? ` · ${models.find((model) => model.id === effective.model)?.label ?? effective.model}` : ''}`}
          selected={!draft.choices.model}
          onPress={() => setDraft(editAgentPickerDraft(draft, { model: null }))}
        />
        {models.map((model) => (
          <Choice
            disabled={disabled}
            key={model.id}
            label={model.label}
            selected={draft.choices.model === model.id}
            onPress={() => setDraft(editAgentPickerDraft(draft, { model: model.id }))}
          />
        ))}
        {draft.choices.model && !models.some((model) => model.id === draft.choices.model) ? (
          <Text style={styles.text}>{draft.choices.model}</Text>
        ) : null}
        {options.map((option) => (
          <View key={option.id} style={styles.field}>
            <Text style={styles.label}>
              {option.label}
              {mode === 'launch' &&
              !agentPickerEntryOptions(entry, effective.model, 'terminal').some(
                (terminal) => terminal.id === option.id
              )
                ? ' · Chat only'
                : ''}
            </Text>
            <View style={styles.options}>
              <Choice
                disabled={disabled}
                label="Default"
                selected={draft.choices.options?.[option.id] === undefined}
                onPress={() =>
                  setDraft(editAgentPickerDraft(draft, { options: { [option.id]: null } }))
                }
              />
              {(option.kind.type === 'select'
                ? option.kind.choices
                : [
                    { value: 'true', label: 'On' },
                    { value: 'false', label: 'Off' }
                  ]
              ).map((choice) => (
                <Choice
                  disabled={disabled}
                  key={choice.value}
                  label={choice.label}
                  selected={draft.choices.options?.[option.id] === choice.value}
                  onPress={() =>
                    setDraft(
                      editAgentPickerDraft(draft, { options: { [option.id]: choice.value } })
                    )
                  }
                />
              ))}
              {draft.choices.options?.[option.id] &&
              !(
                option.kind.type === 'select'
                  ? option.kind.choices.map((choice) => choice.value)
                  : ['true', 'false']
              ).includes(draft.choices.options[option.id]) ? (
                <Text style={styles.text}>{draft.choices.options[option.id]}</Text>
              ) : null}
            </View>
          </View>
        ))}
        <MobileAgentPickerPermissionFields
          entry={entry}
          draft={draft}
          showArguments={draft.surface === 'terminal' || mode === 'launch'}
          disabled={disabled}
          onChange={setDraft}
        />
        <View style={styles.footer}>
          {mode === 'save' ? (
            <Choice label="Use" selected disabled={disabled} onPress={() => onUse(draft)} />
          ) : (
            agentPickerButtonOrder(entry).map((surface) => (
              <Choice
                disabled={disabled}
                key={surface}
                label={surface === 'chat' ? 'Open chat' : 'Open terminal'}
                selected={surface === entry.defaultSurface}
                onPress={() => onUse({ ...draft, surface })}
              />
            ))
          )}
        </View>
      </View>
    )
  }
  return (
    <View style={styles.panel}>
      <TextInput
        accessibilityLabel="Search agents and setups"
        style={styles.input}
        placeholder="Search agents and setups…"
        placeholderTextColor={colors.textMuted}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        onSubmitEditing={() => {
          if (disabled) {
            return
          }
          const setup = setups[0]
          if (setup) {
            onUse({
              agent: setup.entry.agent,
              surface: setup.entry.defaultSurface,
              choices: setup.choices
            })
          } else {
            const entry = entries.find(
              (entry) =>
                entry.surfaces.length &&
                `${entry.label} ${entry.agent}`.toLowerCase().includes(query.toLowerCase())
            )
            if (entry) {
              onUse({ agent: entry.agent })
            }
          }
        }}
      />
      {setups.map((setup) => (
        <View
          key={`${setup.entry.agent}:${setup.model.id}:${setup.choices.options?.effort ?? ''}`}
          style={styles.row}
        >
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            style={styles.main}
            onPress={() =>
              onUse({
                agent: setup.entry.agent,
                surface: setup.entry.defaultSurface,
                choices: setup.choices
              })
            }
          >
            <Text style={styles.text}>{setup.label}</Text>
          </Pressable>
          {setup.entry.surfaces
            .filter((surface) => surface !== setup.entry.defaultSurface)
            .slice(0, 1)
            .map((surface) => (
              <Pressable
                key={surface}
                accessibilityRole="button"
                accessibilityLabel={surface === 'chat' ? 'Open chat' : 'Open terminal'}
                disabled={disabled}
                style={styles.chevron}
                onPress={() => onUse({ agent: setup.entry.agent, surface, choices: setup.choices })}
              >
                <Text style={styles.hint}>{surface === 'chat' ? 'Chat' : 'Terminal'}</Text>
              </Pressable>
            ))}
        </View>
      ))}
      {entries
        .filter((entry) =>
          `${entry.label} ${entry.agent}`.toLowerCase().includes(query.toLowerCase())
        )
        .map((entry) => (
          <View key={entry.agent} style={styles.row}>
            <Pressable
              accessibilityRole="button"
              disabled={disabled || !entry.surfaces.length}
              style={styles.main}
              onPress={() =>
                mode === 'save' ? setDraft(agentPickerDraft(entry)) : onUse({ agent: entry.agent })
              }
            >
              <MobileAgentIcon agentId={entry.agent} size={16} />
              <Text style={styles.text}>{entry.label}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Configure ${entry.label}`}
              disabled={disabled || !entry.surfaces.length || !setupSupported}
              accessibilityHint={
                !setupSupported ? 'Update Orca on this host to choose an agent setup.' : undefined
              }
              style={styles.chevron}
              onPress={() => {
                onSelectAgent?.(entry.agent)
                setDraft(agentPickerDraft(entry))
              }}
            >
              <ChevronRight size={18} color={colors.textSecondary} />
            </Pressable>
          </View>
        ))}
    </View>
  )
}

function Choice({
  label,
  selected,
  disabled,
  onPress
}: {
  label: string
  selected?: boolean
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected), disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.choice, selected && styles.selected]}
    >
      <Text style={[styles.text, selected && styles.selectedText]}>{label}</Text>
    </Pressable>
  )
}
const styles = StyleSheet.create({
  panel: { padding: spacing.lg, gap: spacing.sm },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md
  },
  chevron: { padding: spacing.md },
  label: { color: colors.textSecondary, fontSize: typography.metaSize },
  text: { color: colors.textPrimary, fontSize: typography.bodySize },
  hint: { color: colors.textMuted, fontSize: typography.metaSize },
  field: { gap: spacing.sm, paddingVertical: spacing.sm },
  input: {
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    padding: spacing.md,
    fontSize: typography.bodySize
  },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    padding: spacing.md
  },
  selected: { backgroundColor: colors.surfaceBright },
  selectedText: { color: colors.bgBase },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    paddingTop: spacing.md
  }
})
