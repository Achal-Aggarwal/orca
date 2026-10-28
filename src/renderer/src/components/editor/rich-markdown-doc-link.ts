import { Node } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { isDocLinkResolved, type DocLinkStorage } from './rich-markdown-doc-link-storage'
import { formatMarkdownDocLink, parseMarkdownDocLink } from './markdown-doc-links'
import {
  isReservedRichMarkdownTransportBody,
  skipInlineTransportStartScan,
  type RichMarkdownSourceTransport
} from './rich-markdown-source-transport'
import { renderRichMarkdownDocLinkHtml } from './rich-markdown-doc-link-dom'
import {
  createDocLinkPreviewPlugin,
  findPendingDocLinkConversions
} from './rich-markdown-doc-link-decorations'

const docLinkDissolveKey = new PluginKey('docLinkDissolve')
const docLinkAutoConvertKey = new PluginKey('docLinkAutoConvert')

function getDocLinkTarget(node: { attrs: Record<string, unknown> }): string {
  return typeof node.attrs.target === 'string' ? node.attrs.target : ''
}

function getDocLinkAlias(node: { attrs: Record<string, unknown> }): string | null {
  return typeof node.attrs.label === 'string' && node.attrs.label ? node.attrs.label : null
}

function getDocLinkDisplayText(node: { attrs: Record<string, unknown> }): string {
  return getDocLinkAlias(node) ?? getDocLinkTarget(node)
}

export function createMarkdownDocLink(transport: RichMarkdownSourceTransport) {
  return Node.create<Record<string, never>, DocLinkStorage>({
    name: 'markdownDocLink',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,

    addStorage() {
      return {
        documents: [],
        _cachedDocs: null,
        _cachedIndex: null
      }
    },

    addAttributes() {
      return {
        target: {
          default: '',
          parseHTML: (el: HTMLElement) => el.getAttribute('data-doc-link-target') ?? ''
        },
        label: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute('data-doc-link-label')
        }
      }
    },

    markdownTokenName: 'markdownDocLink',
    markdownTokenizer: {
      name: 'markdownDocLink',
      level: 'inline',
      start: skipInlineTransportStartScan,
      tokenize(src: string) {
        const matched = transport.match(src, 'document-link')
        if (!matched) {
          return undefined
        }
        const link = isReservedRichMarkdownTransportBody(matched.value)
          ? null
          : parseMarkdownDocLink(matched.value)
        if (!link) {
          return undefined
        }

        return {
          type: 'markdownDocLink',
          raw: matched.raw,
          text: link.target,
          label: link.alias ?? undefined
        }
      }
    },

    parseMarkdown: (token, helpers) => {
      if (token.type !== 'markdownDocLink') {
        return []
      }
      return helpers.createNode('markdownDocLink', {
        target: typeof token.text === 'string' ? token.text : '',
        label:
          typeof (token as { label?: unknown }).label === 'string'
            ? (token as { label: string }).label
            : null
      })
    },

    renderMarkdown: (node) =>
      formatMarkdownDocLink(
        typeof node.attrs?.target === 'string' ? node.attrs.target : '',
        typeof node.attrs?.label === 'string' ? node.attrs.label : null
      ),
    renderText: ({ node }) => getDocLinkDisplayText(node),

    addNodeView() {
      const storage = this.storage
      return ({ node }: { node: { type: { name: string }; attrs: Record<string, unknown> } }) => {
        const target = getDocLinkTarget(node)
        const dom = document.createElement('span')
        dom.setAttribute('data-doc-link-target', target)
        const alias = getDocLinkAlias(node)
        if (alias) {
          dom.setAttribute('data-doc-link-label', alias)
        }
        dom.setAttribute('contenteditable', 'false')
        dom.textContent = getDocLinkDisplayText(node)

        const applyResolutionClass = (t: string): void => {
          const resolved = isDocLinkResolved(t, storage)
          dom.className = resolved
            ? 'rich-markdown-doc-link'
            : 'rich-markdown-doc-link rich-markdown-doc-link--missing'
        }

        applyResolutionClass(target)

        return {
          dom,
          // Resolution decorations also trigger this when the document list changes.
          update: (updatedNode: { type: { name: string }; attrs: Record<string, unknown> }) => {
            if (updatedNode.type.name !== 'markdownDocLink') {
              return false
            }
            const newTarget = getDocLinkTarget(updatedNode)
            const newAlias = getDocLinkAlias(updatedNode)
            dom.setAttribute('data-doc-link-target', newTarget)
            if (newAlias) {
              dom.setAttribute('data-doc-link-label', newAlias)
            } else {
              dom.removeAttribute('data-doc-link-label')
            }
            dom.textContent = getDocLinkDisplayText(updatedNode)
            applyResolutionClass(newTarget)
            return true
          }
        }
      }
    },

    // A plugin converts links typed or pasted in any order; input rules cover only sequential appends.
    addProseMirrorPlugins() {
      const nodeType = this.type
      const storage = this.storage
      return [
        // Dissolve adjacent atoms on plain arrows so they can be edited; inspect modifiers to preserve Shift+Arrow selection.
        new Plugin({
          key: docLinkDissolveKey,
          props: {
            handleKeyDown(view, event) {
              if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
                return false
              }
              let direction: 'left' | 'right'
              if (event.key === 'ArrowLeft') {
                direction = 'left'
              } else if (event.key === 'ArrowRight') {
                direction = 'right'
              } else {
                return false
              }
              const { state } = view
              if (!(state.selection instanceof TextSelection) || !state.selection.empty) {
                return false
              }
              const { $from } = state.selection
              const adjacent = direction === 'left' ? $from.nodeBefore : $from.nodeAfter
              if (!adjacent || adjacent.type.name !== 'markdownDocLink') {
                return false
              }
              const target = getDocLinkTarget(adjacent)
              const text = formatMarkdownDocLink(target, getDocLinkAlias(adjacent))
              const nodeStart = direction === 'left' ? $from.pos - adjacent.nodeSize : $from.pos
              const nodeEnd = nodeStart + adjacent.nodeSize
              const tr = state.tr.replaceWith(nodeStart, nodeEnd, state.schema.text(text))
              const cursorPos = direction === 'left' ? nodeStart + text.length - 2 : nodeStart + 2
              tr.setSelection(TextSelection.create(tr.doc, cursorPos))
              view.dispatch(tr)
              return true
            }
          }
        }),

        new Plugin({
          key: docLinkAutoConvertKey,
          appendTransaction(_transactions, _oldState, newState) {
            const { tr } = newState
            const cursor = newState.selection.from
            let modified = false

            for (const candidate of findPendingDocLinkConversions(newState)) {
              const { from, to, target, label } = candidate
              // Keep cursor-owned link text editable until the cursor leaves.
              if (cursor > from && cursor <= to) {
                continue
              }
              const docLinkNode = nodeType.create({ target, label })
              tr.replaceWith(tr.mapping.map(from), tr.mapping.map(to), docLinkNode)
              modified = true
            }

            return modified ? tr : null
          }
        }),

        // Show resolution feedback for link text under the cursor before it converts to an atom.
        createDocLinkPreviewPlugin(storage)
      ]
    },

    parseHTML() {
      return [{ tag: 'span[data-doc-link-target]' }]
    },

    renderHTML({ HTMLAttributes, node }) {
      return renderRichMarkdownDocLinkHtml(node, HTMLAttributes)
    }
  })
}
