import React, { useMemo } from 'react'
import type { Editor } from '@tiptap/react'
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { translate } from '@/i18n/i18n'

type RichMarkdownEmojiMenuProps = {
  editor: Editor | null
  anchorElement: HTMLDivElement | null
  left: number
  top: number
  onClose: () => void
}

export function RichMarkdownEmojiMenu({
  editor,
  anchorElement,
  left,
  top,
  onClose
}: RichMarkdownEmojiMenuProps): React.JSX.Element {
  const isDark = useDocumentDarkTheme()
  const virtualRef = useMemo(
    () => ({
      current: {
        contextElement: anchorElement ?? undefined,
        getBoundingClientRect: () => {
          const rect = anchorElement?.getBoundingClientRect()
          return new DOMRect((rect?.left ?? 0) + left, (rect?.top ?? 0) + top, 0, 0)
        }
      }
    }),
    [anchorElement, left, top]
  )
  const insertEmoji = (emojiData: EmojiClickData): void => {
    editor?.chain().focus().insertContent(emojiData.emoji).run()
    onClose()
  }

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        className="rich-markdown-emoji-menu p-0"
        align="start"
        sideOffset={0}
        collisionPadding={8}
        style={{ colorScheme: isDark ? 'dark' : 'light' }}
        aria-label={translate('components.editor.emojiPicker.label', 'Choose an emoji')}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => editor?.commands.focus()}
      >
        <EmojiPicker
          autoFocusSearch
          emojiStyle={EmojiStyle.NATIVE}
          height={360}
          lazyLoadEmojis
          onEmojiClick={insertEmoji}
          previewConfig={{ showPreview: false }}
          searchPlaceHolder={translate('components.editor.emojiPicker.search', 'Search emoji')}
          skinTonesDisabled
          theme={isDark ? Theme.DARK : Theme.LIGHT}
          width={320}
        />
      </PopoverContent>
    </Popover>
  )
}
