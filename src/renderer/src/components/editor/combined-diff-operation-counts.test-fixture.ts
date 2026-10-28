import type { editor } from 'monaco-editor'

// Only installer-facing calls are decorated; Monaco keeps its original editors and receivers.
export function countPaneReads(
  diff: editor.IStandaloneDiffEditor,
  method: 'getScrolledVisiblePosition' | 'getContentHeight',
  onRead: () => void
): editor.IStandaloneDiffEditor {
  const countedPane = (pane: editor.IStandaloneCodeEditor): editor.IStandaloneCodeEditor =>
    new Proxy(pane, {
      get(_target, key) {
        switch (key) {
          case 'getScrolledVisiblePosition':
            return (...args: Parameters<editor.ICodeEditor['getScrolledVisiblePosition']>) => {
              if (method === 'getScrolledVisiblePosition') {
                onRead()
              }
              return pane.getScrolledVisiblePosition(...args)
            }
          case 'getContentHeight':
            return () => {
              if (method === 'getContentHeight') {
                onRead()
              }
              return pane.getContentHeight()
            }
          case 'getPosition':
            return pane.getPosition.bind(pane)
          case 'getContainerDomNode':
            return pane.getContainerDomNode.bind(pane)
          case 'onDidChangeCursorPosition':
            return pane.onDidChangeCursorPosition.bind(pane)
          case 'onDidLayoutChange':
            return pane.onDidLayoutChange.bind(pane)
          case 'onDidScrollChange':
            return pane.onDidScrollChange.bind(pane)
          case 'onDidBlurEditorText':
            return pane.onDidBlurEditorText.bind(pane)
          default:
            throw new Error(`Unmodeled installer pane access: ${String(key)}`)
        }
      }
    })
  return new Proxy(diff, {
    get(_target, key) {
      switch (key) {
        case 'getOriginalEditor':
          return () => countedPane(diff.getOriginalEditor())
        case 'getModifiedEditor':
          return () => countedPane(diff.getModifiedEditor())
        case 'getContainerDomNode':
          return diff.getContainerDomNode.bind(diff)
        case 'getLineChanges':
          return diff.getLineChanges.bind(diff)
        case 'onDidContentSizeChange':
          return diff.onDidContentSizeChange.bind(diff)
        case 'onDidUpdateDiff':
          return diff.onDidUpdateDiff.bind(diff)
        default:
          throw new Error(`Unmodeled installer diff access: ${String(key)}`)
      }
    }
  })
}
