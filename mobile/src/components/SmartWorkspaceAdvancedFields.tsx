import { useRef } from 'react'
import { Platform, Text, TextInput, View } from 'react-native'
import type { MobileComposerSource } from '../tasks/use-mobile-composer-source'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileSegmentedControl } from './MobileSegmentedControl'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'

type Props = {
  composer: MobileComposerSource
  selectedRepoIsGit: boolean
}

// Show editable Name after source pill; branch override/reuse follow desktop’s advanced composer fields.
export function SmartWorkspaceAdvancedFields({ composer, selectedRepoIsGit }: Props) {
  useMobileColorScheme()
  const branchNameInputRef = useRef<TextInput>(null)
  const selection = composer.smartNameSelection
  const showBranchOverride = selectedRepoIsGit && (!selection || selection.kind === 'branch')
  return (
    <>
      {selection ? (
        <View style={styles.field}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={composer.name}
            onChangeText={composer.setName}
            placeholder="Workspace name"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ) : null}

      {showBranchOverride && !composer.reuseEligibleBranch ? (
        <View style={styles.field}>
          <Text style={styles.label}>Branch name</Text>
          <TextInput
            style={styles.input}
            value={composer.branchNameOverride ?? ''}
            onChangeText={composer.handleBranchNameOverrideChange}
            placeholder="Derived from name"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ) : null}

      {composer.reuseEligibleBranch ? (
        <View style={styles.field}>
          <Text style={styles.label}>Branch for this worktree</Text>
          <MobileSegmentedControl
            segments={[
              { value: 'existing', label: 'Existing branch' },
              { value: 'new', label: 'New branch' }
            ]}
            selected={composer.reuseSelectedBranch ? 'existing' : 'new'}
            onSelect={(value) => {
              composer.setReuseSelectedBranch(value === 'existing')
              if (value === 'new') {
                branchNameInputRef.current?.focus()
              }
            }}
            fill
          />
          {composer.reuseSelectedBranch ? (
            <View style={styles.branchDetail}>
              <Text style={styles.branchName}>{composer.reuseEligibleBranch}</Text>
              <Text style={styles.description}>New commits go on this branch.</Text>
            </View>
          ) : (
            <View style={styles.branchDetail}>
              <Text style={styles.description}>Create a new local branch</Text>
              <Text style={styles.label}>New branch name</Text>
              <TextInput
                ref={branchNameInputRef}
                accessibilityLabel="New branch name"
                autoFocus
                style={styles.input}
                value={composer.branchNameOverride ?? ''}
                onChangeText={composer.handleBranchNameOverrideChange}
                placeholder="Automatic name"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          )}
        </View>
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  field: {
    marginBottom: spacing.md
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: spacing.xs
  },
  input: {
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm,
    fontSize: TEXT_INPUT_FONT_SIZE,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  branchDetail: {
    marginTop: spacing.sm,
    gap: spacing.xs
  },
  branchName: {
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    color: colors.textPrimary
  },
  description: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  }
}))
