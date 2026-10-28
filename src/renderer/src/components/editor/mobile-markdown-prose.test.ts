// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { createTiptapMarkedFacade } from './tiptap-marked-facade'
import { blockMarkdown } from '../../../../../mobile/src/components/rich-markdown/html-block-markdown'

const marked = createTiptapMarkedFacade()

it.each([
  '\\*literal*',
  '\\&amp;',
  '\\[label](target)',
  'C:\\tmp\\folder',
  '\\\\',
  'one\\|two',
  '**literal** and &amp;',
  '[literal](https://example.com)',
  '# Heading'
])('reads mobile-saved literal prose %j in the desktop reader', async (literal) => {
  for (const tag of ['span', 'strong', 'em', 's', 'code']) {
    const paragraph = document.createElement('p')
    const content = document.createElement(tag)
    content.textContent = literal
    paragraph.append(content)
    const html = await marked.parse(blockMarkdown(paragraph))
    if (typeof html !== 'string') {
      throw new Error('The desktop Markdown reader did not return HTML')
    }
    const output = document.createElement('template')
    output.innerHTML = html
    const reloaded = output.content.firstElementChild!
    expect(reloaded.tagName).toBe('P')
    expect(reloaded.textContent).toBe(literal)
    expect(reloaded.querySelectorAll('strong,em,del,code')).toHaveLength(tag === 'span' ? 0 : 1)
    expect(reloaded.querySelectorAll('a,img,ul,ol,h1,blockquote,table,hr')).toHaveLength(0)
  }
})
