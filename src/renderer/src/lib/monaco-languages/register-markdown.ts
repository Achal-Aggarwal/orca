import type * as Monaco from 'monaco-editor'
import {
  buildMarkdownHeadingSections,
  type MarkdownHeadingSection
} from './markdown-heading-outline'

type MonacoModule = Pick<typeof Monaco, 'languages' | 'editor'>

const MARKDOWN_LANGUAGE_ID = 'markdown'

function toDocumentSymbol(
  monaco: MonacoModule,
  model: Monaco.editor.ITextModel,
  section: MarkdownHeadingSection
): Monaco.languages.DocumentSymbol {
  return {
    name: section.title || '#'.repeat(section.level),
    detail: '',
    kind: monaco.languages.SymbolKind.String,
    tags: [],
    range: {
      startLineNumber: section.startLine,
      startColumn: 1,
      endLineNumber: section.endLine,
      endColumn: model.getLineMaxColumn(section.endLine)
    },
    selectionRange: {
      startLineNumber: section.startLine,
      startColumn: 1,
      endLineNumber: section.headingEndLine,
      endColumn: model.getLineMaxColumn(section.headingEndLine)
    },
    children: section.children.map((child) => toDocumentSymbol(monaco, model, child))
  }
}

/** VS Code's markdown editing: TextMate colors, no bracket-pair colors, and a heading outline for sticky scroll. */
export function registerMarkdownLanguage(monaco: MonacoModule): void {
  // Why: Monaco merges configurations per field, so this keeps the built-in markdown config and drops only bracket colors.
  monaco.languages.setLanguageConfiguration(MARKDOWN_LANGUAGE_ID, { colorizedBracketPairs: [] })

  let tokensProviderPromise: Promise<Monaco.languages.TokensProvider> | undefined
  monaco.languages.registerTokensProviderFactory(MARKDOWN_LANGUAGE_ID, {
    create: () => {
      tokensProviderPromise ??= import('./markdown-textmate-tokens')
        .then(({ createMarkdownTokensProvider }) => createMarkdownTokensProvider(monaco))
        .catch((error: unknown) => {
          tokensProviderPromise = undefined
          throw error
        })
      return tokensProviderPromise
    }
  })

  monaco.languages.registerDocumentSymbolProvider(MARKDOWN_LANGUAGE_ID, {
    displayName: 'Markdown headings',
    provideDocumentSymbols: (model) =>
      buildMarkdownHeadingSections(model.getLinesContent()).map((section) =>
        toDocumentSymbol(monaco, model, section)
      )
  })
}
