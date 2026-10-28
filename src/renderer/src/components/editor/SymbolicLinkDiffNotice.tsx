import { translate } from '@/i18n/i18n'

export function SymbolicLinkDiffNotice(): React.JSX.Element {
  return (
    <div className="border-b border-border px-3 py-1 text-xs text-muted-foreground">
      {translate('editor.symbolicLinkDiff', 'Symbolic link target · Read-only')}
    </div>
  )
}
