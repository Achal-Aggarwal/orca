import type { editor, IDisposable } from 'monaco-editor'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isUtf8ByteLengthWithinLimit } from '../../../../shared/utf8-byte-limits'
import { MONACO_PASTE_MAX_BYTES } from './monaco-large-text-paste'

type NativePasteEditor = Pick<
  editor.ICodeEditor,
  'getContainerDomNode' | 'hasTextFocus' | 'onDidDispose'
> & {
  getOption: (option: editor.EditorOption.readOnly) => boolean
}

type NativePasteEditors = {
  getEditors: () => readonly NativePasteEditor[]
  onDidCreateEditor: (listener: (instance: NativePasteEditor) => void) => IDisposable
}

const nativeGuardOwners = new WeakMap<NativePasteEditor, object>()

export function registerMonacoNativePasteGuardOwner(instance: NativePasteEditor): () => void {
  const owner = {}
  nativeGuardOwners.set(instance, owner)
  return () => {
    if (nativeGuardOwners.get(instance) === owner) {
      nativeGuardOwners.delete(instance)
    }
  }
}

export function installMonacoNativePasteLimit(
  editors: NativePasteEditors,
  readOnlyOption: editor.EditorOption.readOnly,
  captureNode: Document = document
): () => void {
  const editorByNode = new WeakMap<EventTarget, NativePasteEditor>()
  const disposals = new Map<NativePasteEditor, IDisposable>()
  const registerEditor = (instance: NativePasteEditor): void => {
    if (disposals.has(instance)) {
      return
    }
    const node = instance.getContainerDomNode()
    editorByNode.set(node, instance)
    disposals.set(
      instance,
      instance.onDidDispose(() => {
        if (editorByNode.get(node) === instance) {
          editorByNode.delete(node)
        }
        disposals.delete(instance)
      })
    )
  }
  const editorCreation = editors.onDidCreateEditor(registerEditor)
  editors.getEditors().forEach(registerEditor)

  const onPaste = (event: ClipboardEvent): void => {
    if (event.defaultPrevented) {
      return
    }
    const instance = event
      .composedPath()
      .map((node) => editorByNode.get(node))
      .find(Boolean)
    if (
      !instance?.hasTextFocus() ||
      instance.getOption(readOnlyOption) ||
      nativeGuardOwners.has(instance)
    ) {
      return
    }
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (isUtf8ByteLengthWithinLimit(text, MONACO_PASTE_MAX_BYTES)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    toast.error(
      translate('auto.components.editor.MonacoEditor.largePasteTooLarge', 'Paste is too large.')
    )
  }
  captureNode.addEventListener('paste', onPaste, { capture: true })
  return () => {
    captureNode.removeEventListener('paste', onPaste, { capture: true })
    editorCreation.dispose()
    disposals.forEach((disposal) => disposal.dispose())
    disposals.clear()
  }
}
