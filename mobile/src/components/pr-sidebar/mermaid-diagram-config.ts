import { colors } from '../../theme/mobile-theme'

// Suppress mermaid error SVG: render failure uses source fallback, and default error rendering leaves orphan temporary SVG in page.
export const MERMAID_DIAGRAM_CONFIG = {
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'strict',
  darkMode: true,
  suppressErrorRendering: true,
  // The page's own text face; mermaid defaults to Trebuchet.
  fontFamily: 'system-ui, sans-serif',
  themeVariables: {
    background: colors.bgRaised,
    primaryColor: colors.bgPanel,
    primaryBorderColor: colors.borderSubtle,
    nodeBorder: colors.borderSubtle,
    primaryTextColor: colors.textPrimary,
    lineColor: colors.textSecondary,
    textColor: colors.textPrimary
  }
} as const
