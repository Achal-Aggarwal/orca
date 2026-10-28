import React, { useCallback } from 'react'
import { Copy, Check } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useClipboardCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'

type CodeBlockCopyButtonProps = React.HTMLAttributes<HTMLPreElement> & {
  children?: React.ReactNode
}

export default function CodeBlockCopyButton({
  children,
  ...props
}: CodeBlockCopyButtonProps): React.JSX.Element {
  const { feedback, copyText } = useClipboardCopyFeedback({ showFailure: false })
  const copied = feedback?.status === 'copied'

  const handleCopy = useCallback(() => {
    // Extract raw text from react-markdown’s nested code children so the clipboard receives no markup.
    let text = ''
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.props) {
        const inner = (child.props as { children?: React.ReactNode }).children
        text += typeof inner === 'string' ? inner : extractText(inner)
      } else if (typeof child === 'string') {
        text += child
      }
    })

    void copyText(text)
  }, [children, copyText])

  return (
    <div className="code-block-wrapper">
      <pre {...props}>{children}</pre>
      <button
        type="button"
        className="code-block-copy-btn"
        onClick={handleCopy}
        aria-label={translate('auto.components.editor.CodeBlockCopyButton.1f9f4def45', 'Copy code')}
        title={translate('auto.components.editor.CodeBlockCopyButton.1f9f4def45', 'Copy code')}
      >
        {copied ? (
          <>
            <Check size={14} />
            <span className="code-block-copy-label">
              {translate('auto.components.editor.CodeBlockCopyButton.28921f5bf9', 'Copied')}
            </span>
          </>
        ) : (
          <Copy size={14} />
        )}
      </button>
    </div>
  )
}

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join('')
  }
  if (React.isValidElement(node) && node.props) {
    return extractText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}
