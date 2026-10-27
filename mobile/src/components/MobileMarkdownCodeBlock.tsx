import { memo, useMemo } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { highlightMobileCode } from '../session/mobile-file-syntax'
import { MobileSyntaxSegments } from './MobileSyntaxSegments'
import { MobileSourceCopyButton } from './MobileSourceCopyButton'
import { scaledMarkdownText, styles } from './mobile-markdown-styles'
import { MarkdownText } from './mobile-markdown-text'

export const MobileMarkdownCodeBlock = memo(function MobileMarkdownCodeBlock({
  code,
  language,
  textScale
}: {
  code: string
  language: string | undefined
  textScale: number
}) {
  const segments = useMemo(
    () => (language ? highlightMobileCode(code, language.toLowerCase()).segments : null),
    [code, language]
  )
  const lineNumbers = useMemo(
    () => Array.from({ length: code.split('\n').length }, (_, index) => index + 1).join('\n'),
    [code]
  )
  const metrics = [styles.codeText, scaledMarkdownText(styles.codeText, textScale)]
  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHeader}>
        <Text numberOfLines={1} style={styles.codeLanguage}>
          {language ?? 'Code'}
        </Text>
        {code ? <MobileSourceCopyButton text={code} accessibilityLabel="Copy code" /> : null}
      </View>
      <View style={styles.codeBody}>
        {/* A separate column, so selecting or copying the code never picks up line numbers. */}
        {code ? (
          <Text selectable={false} aria-hidden style={[metrics, styles.codeLineNumbers]}>
            {lineNumbers}
          </Text>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <MarkdownText selectable style={[metrics, styles.codeLines]}>
            {segments ? <MobileSyntaxSegments segments={segments} /> : code}
          </MarkdownText>
        </ScrollView>
      </View>
    </View>
  )
})
