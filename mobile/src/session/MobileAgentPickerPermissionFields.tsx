import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native'
import { colors, spacing, typography, radii } from '../theme/mobile-theme'
import {
  agentPickerPermissions,
  editAgentPickerArguments,
  editAgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerDraft
} from '../../../src/shared/agent-launch-picker'
import { agentPickerArgumentPermission } from '../../../src/shared/agent-launch-picker-permission'

const permissionLabels = {
  own: 'Use agent configuration',
  ask: 'Ask',
  'accept-edits': 'Accept edits',
  auto: 'Approve for me',
  'full-access': 'Full access'
}

export function MobileAgentPickerPermissionFields({
  entry,
  draft,
  showArguments,
  disabled,
  onChange
}: {
  entry: AgentPickerEntry
  draft: AgentPickerDraft
  showArguments: boolean
  disabled?: boolean
  onChange: (draft: AgentPickerDraft) => void
}) {
  const permission = agentPickerArgumentPermission(entry, draft)
  const owned = permission?.locked ? permission : undefined
  return (
    <>
      <Text style={styles.label}>Permissions</Text>
      <View style={styles.options}>
        {(owned
          ? [{ value: 'arguments', label: owned.flag }]
          : [
              { value: 'default', label: 'Agents defaults' },
              ...agentPickerPermissions(entry.agent, draft.surface).map((value) => ({
                value,
                label: permissionLabels[value]
              }))
            ]
        ).map(({ value, label }) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{
              disabled: Boolean(disabled || owned),
              selected: Boolean(owned || (draft.choices.permissionMode ?? 'default') === value)
            }}
            disabled={disabled || Boolean(owned)}
            style={[
              styles.choice,
              (owned || (draft.choices.permissionMode ?? 'default') === value) && styles.selected
            ]}
            onPress={() => {
              const choice = agentPickerPermissions(entry.agent, draft.surface).find(
                (choice) => choice === value
              )
              onChange(editAgentPickerDraft(draft, { permissionMode: choice ?? 'default' }))
            }}
          >
            <Text
              style={[
                styles.text,
                (owned || (draft.choices.permissionMode ?? 'default') === value) &&
                  styles.selectedText
              ]}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      {showArguments ? (
        <View style={styles.field}>
          <Text style={styles.label}>Arguments</Text>
          {permission ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${permission.flag}`}
              disabled={disabled}
              style={styles.choice}
              onPress={() =>
                onChange(editAgentPickerArguments(draft, permission.remainingArguments))
              }
            >
              <Text style={[styles.text, styles.code]}>{permission.flag} ×</Text>
            </Pressable>
          ) : null}
          <TextInput
            accessibilityLabel="Arguments"
            style={[styles.input, styles.code]}
            value={
              permission?.remainingArguments ??
              (draft.arguments === undefined ? entry.arguments : draft.arguments) ??
              ''
            }
            onChangeText={(text) =>
              onChange(
                editAgentPickerArguments(draft, [permission?.flag, text].filter(Boolean).join(' '))
              )
            }
            editable={!disabled}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.hint}>
            Applies only to CLI launches. {draft.arguments === undefined ? 'Agents defaults' : ''}
          </Text>
          {draft.arguments !== undefined ? (
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => onChange({ ...draft, arguments: undefined })}
            >
              <Text style={styles.text}>Reset to default</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  label: { color: colors.textSecondary, fontSize: typography.metaSize },
  text: { color: colors.textPrimary, fontSize: typography.bodySize },
  hint: { color: colors.textMuted, fontSize: typography.metaSize },
  code: { fontFamily: typography.monoFamily },
  field: { gap: spacing.sm, paddingVertical: spacing.sm },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  selected: { backgroundColor: colors.surfaceBright },
  selectedText: { color: colors.bgBase },
  choice: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    padding: spacing.md
  },
  input: {
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    padding: spacing.md,
    fontSize: typography.bodySize
  }
})
