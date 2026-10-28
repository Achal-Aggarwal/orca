import { expect, it } from 'vitest'

const samples = [
  { literal: '**literal**' },
  { literal: '\\*literal*' },
  { literal: '\\&amp;' },
  { literal: '\\[label](target)' },
  { literal: 'C:\\tmp\\folder' },
  { literal: '\\\\' },
  { literal: 'one\\|two' },
  { literal: '_literal_ and *literal*' },
  { literal: '~~literal~~' },
  { literal: '`literal`' },
  { literal: '[literal](https://example.com)' },
  { literal: '![literal](/inserted.png)' },
  { literal: 'a &amp; &#38; &lt;tag&gt; &#x1f600;' },
  { literal: 'R&D <tag> "quoted" and \'apostrophe\'' },
  { literal: 'https://example.com' },
  { literal: '# Heading' },
  { literal: '- List item' },
  { literal: '+ List item' },
  { literal: '12. List item' },
  { literal: '12) List item' },
  { literal: '- [ ] Task' },
  { literal: '> Quoted' },
  { literal: '---' },
  { literal: '```html' },
  { literal: 'one | two\n--- | ---\na | b' },
  { literal: '**literal** and &amp;', mark: 'Bold' },
  { literal: '_literal_ and &amp;', mark: 'Italic' },
  { literal: '~~literal~~ and &amp;', mark: 'Strike' },
  { literal: '*literal*', mark: 'Inline code' },
  { literal: 'Unmatched * and [ and `' },
  { literal: 'ordinary words and sentence punctuation. Done!' }
]

const readProse = (page) =>
  page.evaluate(() => {
    const editor = document.querySelector('#first-surface #editor')
    const marks = [
      'strong,b',
      'em,i',
      's,del,strike',
      'code',
      'a',
      'img',
      'pre',
      'ul',
      'ol',
      'h1',
      'blockquote',
      'table',
      'hr'
    ]
    return {
      blocks: Array.from(editor.children, (child) => ({
        tag: child.tagName,
        text: child.textContent
      })),
      marks: marks.map((selector) => editor.querySelectorAll(selector).length)
    }
  })

async function prepareProse(page, sample, setContent, press) {
  await setContent(page, 'Placeholder\n\nUnrelated', '<p>Placeholder</p>\n<p>Unrelated</p>')
  const selectFirst = () =>
    page.evaluate(() => {
      const editor = document.querySelector('#first-surface #editor')
      editor.focus()
      const range = document.createRange()
      range.selectNodeContents(editor.querySelector('p'))
      window.getSelection().removeAllRanges()
      window.getSelection().addRange(range)
    })
  await selectFirst()
  await page.keyboard.insertText(sample.literal)
  if (sample.mark) {
    await selectFirst()
    await press(page, sample.mark)
  }
}

export function proseFidelityTest(getBrowser, openPage, setContent, press) {
  it('keeps typed literal prose and real marks through unrelated edits and host reloads', async () => {
    for (const sample of samples) {
      const { page, consoleErrors } = await openPage(getBrowser())
      try {
        await prepareProse(page, sample, setContent, press)
        const marks = (await readProse(page)).marks
        for (let cycle = 1; cycle <= 3; cycle += 1) {
          await page.locator('#first-surface #editor p').last().click()
          await page.keyboard.press('End')
          await page.keyboard.type('!')
          const before = await readProse(page)
          const saved = await page.evaluate(() => globalThis.__orcaEditor.changes.at(-1))
          expect(typeof saved).toBe('string')
          await page.evaluate(
            ({ content, generation }) => {
              globalThis.__beforeProseReload = document.querySelector('#first-surface #editor')
              globalThis.__orcaEditor.set({ content, generation })
            },
            { content: saved, generation: cycle }
          )
          await page.waitForFunction(
            () =>
              document.querySelector('#first-surface #editor') !== globalThis.__beforeProseReload &&
              document.querySelector('#first-surface #editor')?.textContent.includes('Unrelated')
          )
          expect(await readProse(page)).toEqual({ ...before, marks })
        }
        expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
        expect(consoleErrors).toEqual([])
      } finally {
        await page.close()
      }
    }
  }, 600_000)
}
