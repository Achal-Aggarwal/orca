import { useState } from 'react'
import type { AgentLaunchResult } from '../../../src/shared/agent-launch-intent'
import { Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native'
import { useClipboardWriter } from '../platform/clipboard'
import {
  AGENT_LAUNCH_STATUS_UNREADABLE_MESSAGE,
  AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE
} from '../session/mobile-existing-agent-launch'
import type { MobileAgentLaunchAvailability } from '../session/mobile-agent-launch-availability'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { AgentLaunchButton } from './AgentLaunchButton'

type Props = {
  availability: MobileAgentLaunchAvailability
  launch: AgentLaunchResult | null
  error: string | null
  /** The prompt of an agent that started without it, offered for the user to paste in. */
  undeliveredPrompt: string | null
  errorStyle: StyleProp<TextStyle>
}

/** The status line under an AI button that starts an agent with a prompt. */
export function AgentLaunchNotice({
  availability,
  launch,
  error,
  undeliveredPrompt,
  errorStyle
}: Props) {
  useMobileColorScheme()
  const clipboard = useClipboardWriter()
  const [copyState, setCopyState] = useState<{ prompt: string; label: string } | null>(null)
  const availabilityMessage =
    availability === 'update-required'
      ? AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE
      : availability === 'unverified'
        ? AGENT_LAUNCH_STATUS_UNREADABLE_MESSAGE
        : null
  const message = availabilityMessage ?? error
  if (!message && !launch) {
    return null
  }
  const copyLabel =
    copyState && copyState.prompt === undeliveredPrompt ? copyState.label : 'Copy prompt'
  return (
    <View style={styles.notice}>
      {message ? <Text style={errorStyle}>{message}</Text> : null}
      {launch?.warning?.trim() ? (
        <Text style={styles.warningText}>{launch.warning.trim()}</Text>
      ) : null}
      {launch ? <AgentLaunchButton launch={launch} /> : null}
      {undeliveredPrompt ? (
        <Pressable
          onPress={() => {
            clipboard.writeText(undeliveredPrompt).then(
              () => setCopyState({ prompt: undeliveredPrompt, label: 'Copied' }),
              () => setCopyState({ prompt: undeliveredPrompt, label: "Couldn't copy" })
            )
          }}
          accessibilityRole="button"
          accessibilityLabel="Copy prompt"
          hitSlop={spacing.sm}
        >
          <Text style={styles.copyText}>{copyLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  notice: {
    gap: spacing.xs
  },
  warningText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  copyText: {
    color: colors.accentBlue,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
}))
