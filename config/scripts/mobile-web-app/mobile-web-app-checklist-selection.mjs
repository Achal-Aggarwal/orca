import { expect, it } from 'vitest'

const positiveCases = [
  {
    markdown: '- before\n\nSelected text\n\n- after',
    paragraph: 1,
    tasks: ['Selected text'],
    saved: '- before\n\n- [ ] Selected text\n\n- after'
  },
  {
    markdown: '- [x] before\n\nSelected text\n\n- [ ] after',
    paragraph: 1,
    tasks: ['before', 'Selected text', 'after'],
    saved: '- [x] before\n\n- [ ] Selected text\n\n- [ ] after'
  },
  {
    markdown: '**Selected text**',
    start: ['strong', 0, 0],
    end: ['strong', 0, 13],
    tasks: ['Selected text'],
    saved: '- [ ] **Selected text**',
    marks: { strong: 1 }
  },
  {
    markdown: 'Selected text\n\n> unrelated',
    paragraph: 0,
    tasks: ['Selected text'],
    saved: '- [ ] Selected text\n\n> unrelated'
  },
  { html: '<p><br></p>', collapsed: true, paragraph: 0, tasks: ['Task'], saved: '- [ ] Task' },
  {
    markdown: 'Before [notes](../notes.md#topic) after',
    tasks: ['Before notes after'],
    saved: '- [ ] Before [notes](../notes.md#topic) after',
    marks: { a: 1 }
  },
  { markdown: 'Selected text', tasks: ['Selected text'], saved: '- [ ] Selected text' },
  {
    markdown: 'Before\n\nSelected text\n\nAfter',
    paragraph: 1,
    tasks: ['Selected text'],
    saved: 'Before\n\n- [ ] Selected text\n\nAfter'
  },
  { markdown: 'first\n\nsecond', tasks: ['first', 'second'], saved: '- [ ] first\n- [ ] second' },
  {
    markdown: '**bold** and *italic* and ~~gone~~',
    tasks: ['bold and italic and gone'],
    saved: '- [ ] **bold** and *italic* and ~~gone~~',
    marks: { strong: 1, em: 1, s: 1 }
  },
  {
    html: '<p><b>bold</b> and <i>italic</i> and <strike>gone</strike></p>',
    tasks: ['bold and italic and gone'],
    saved: '- [ ] **bold** and *italic* and ~~gone~~',
    marks: { strong: 1, em: 1, s: 1 }
  },
  { markdown: 'one\nline', tasks: ['one', 'line'], saved: '- [ ] one\n- [ ] line' },
  {
    html: '<p><strong>one<br>line</strong></p>',
    tasks: ['one', 'line'],
    saved: '- [ ] **one**\n- [ ] **line**',
    marks: { strong: 2 }
  },
  {
    markdown: 'prefix `code literal` suffix',
    tasks: ['prefix code literal suffix'],
    saved: '- [ ] prefix `code literal` suffix',
    marks: { code: 1 }
  },
  {
    markdown: 'Before [link](https://example.com) after',
    tasks: ['Before link after'],
    saved: '- [ ] Before [link](https://example.com) after',
    marks: { a: 1 }
  },
  {
    literal: '# Heading\n- list\n> quote\n---',
    tasks: ['# Heading', '- list', '> quote', '---'],
    saved: '- [ ] # Heading\n- [ ] - list\n- [ ] > quote\n- [ ] ---'
  },
  {
    literal: 'Unmatched * and [ and ` and ~',
    tasks: ['Unmatched * and [ and ` and ~'],
    saved: '- [ ] Unmatched * and [ and ` and ~'
  },
  {
    markdown: 'Before\n\nAfter',
    paragraph: 1,
    collapsed: true,
    tasks: ['Task'],
    saved: 'Before\n\n- [ ] Task\n\nAfter'
  }
]

const protectedCases = [
  { markdown: 'prefix selected suffix', start: ['p', 0, 7], end: ['p', 0, 15] },
  {
    markdown: 'Prefix first\n\nMiddle text\n\nlast suffix',
    start: ['p', 0, 7],
    end: ['p', 2, 4]
  },
  {
    markdown: 'prefix **first middle last** suffix',
    start: ['strong', 0, 6],
    end: ['strong', 0, 12]
  },
  {
    markdown: 'prefix `first middle last` suffix',
    start: ['code', 0, 6],
    end: ['code', 0, 12]
  },
  { markdown: '# Heading title' },
  { markdown: 'left ![pixel](/inserted.png) right' },
  { markdown: '- first\n- second' },
  { markdown: '- [ ] first\n- [x] second' },
  { markdown: '| one | two |\n| --- | --- |\n| a | b |' },
  { markdown: '> Quoted' },
  { markdown: '```ts\nconst a = 1\nconst b = 2\n```' },
  { markdown: 'Before\n\n---\n\nAfter' },
  { html: '<p>one<br><br>two</p>' },
  { html: '<p>one<br></p>' },
  { literal: ' padded ' },
  { literal: '**literal** and *literal*' },
  { literal: '[literal](https://example.com)' },
  { literal: '`literal`' },
  { literal: 'a &amp; &lt;tag&gt;' },
  { literal: 'https://example.com' },
  { html: '<p>one<span contenteditable="false">control</span>two</p>' },
  { html: '<p>one<!-- private -->two</p>' },
  { html: '<p><strong>one <em>two</em></strong></p>' }
]

async function prepareSelection(page, sample, setContent, select) {
  await setContent(page, 'placeholder', '<p>placeholder</p>')
  if (sample.markdown) {
    await page.evaluate((content) => globalThis.__orcaEditor.set({ content }), sample.markdown)
    await page.waitForFunction(
      () => document.querySelector('#first-surface #editor').innerHTML !== '<p>placeholder</p>'
    )
  }
  if (sample.html) {
    await page.evaluate((html) => {
      document.querySelector('#first-surface #editor').innerHTML = html
    }, sample.html)
  }
  if (sample.literal !== undefined) {
    await page.locator('#first-surface #editor').click()
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+a`)
    await page.keyboard.insertText(sample.literal)
  }
  await (sample.start || sample.paragraph !== undefined
    ? page.evaluate((value) => {
        const editor = document.querySelector('#first-surface #editor')
        editor.focus()
        const range = document.createRange()
        if (value.paragraph !== undefined) {
          const paragraph = editor.querySelectorAll('p')[value.paragraph]
          range.selectNodeContents(paragraph)
          if (value.collapsed) {
            range.collapse(true)
          }
        } else {
          const point = ([selector, index, offset]) => {
            const walker = document.createTreeWalker(
              editor.querySelectorAll(selector)[index],
              NodeFilter.SHOW_TEXT
            )
            let node = walker.nextNode()
            while (node && offset > node.textContent.length) {
              offset -= node.textContent.length
              node = walker.nextNode()
            }
            return [node, offset]
          }
          range.setStart(...point(value.start))
          range.setEnd(...point(value.end))
        }
        window.getSelection().removeAllRanges()
        window.getSelection().addRange(range)
      }, sample)
    : select(page, 'all'))
  await page.evaluate(() => {
    globalThis.__orcaEditor.changes.length = 0
  })
}

const taskTexts = (page) =>
  page.locator('#first-surface #editor ul[data-type="taskList"] > li').allTextContents()

async function verifyHistoryAndReload(page, sample, before, selected, readSurface) {
  await expect
    .poll(() => page.evaluate(() => globalThis.__orcaEditor.changes.at(-1)))
    .toBe(sample.saved)
  expect(await taskTexts(page)).toEqual(sample.tasks)
  const applied = await readSurface(page)
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.keyboard.press(`${modifier}+z`)
    await expect.poll(() => readSurface(page)).toBe(before)
    expect(await page.evaluate(() => window.getSelection().toString())).toBe(selected)
    await page.keyboard.press(`${modifier}+Shift+z`)
    await expect.poll(() => readSurface(page)).toBe(applied)
    expect(await page.evaluate(() => globalThis.__orcaEditor.changes.at(-1))).toBe(sample.saved)
  }
  await page.evaluate((content) => {
    globalThis.__beforeChecklistReload = document.querySelector('#first-surface #editor')
    globalThis.__orcaEditor.set({ content, generation: 1 })
  }, sample.saved)
  await page.waitForFunction(
    () =>
      document.querySelector('#first-surface #editor') !== globalThis.__beforeChecklistReload &&
      document.querySelector('#first-surface #editor ul[data-type="taskList"]') !== null
  )
  expect(await taskTexts(page)).toEqual(sample.tasks)
  for (const [tag, count] of Object.entries(sample.marks ?? {})) {
    expect(await page.locator(`#first-surface #editor ${tag}`).count()).toBe(count)
  }
}

async function verifyChecklistCases(
  getBrowser,
  openPage,
  setContent,
  select,
  press,
  readSurface,
  samples
) {
  for (const sample of samples) {
    const { page, consoleErrors } = await openPage(getBrowser())
    try {
      await prepareSelection(page, sample, setContent, select)
      const before = await readSurface(page)
      const selected = await page.evaluate(() => window.getSelection().toString())
      await press(page, 'Checklist')
      if (sample.saved !== undefined) {
        await verifyHistoryAndReload(page, sample, before, selected, readSurface)
      } else {
        expect(await readSurface(page)).toBe(before)
        expect(await page.evaluate(() => window.getSelection().toString())).toBe(selected)
        expect(await page.evaluate(() => globalThis.__orcaEditor.changes)).toEqual([])
      }
      expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
      expect(consoleErrors).toEqual([])
    } finally {
      await page.close()
    }
  }
}

export function checklistSelectionTest(
  getBrowser,
  openPage,
  setContent,
  select,
  press,
  readSurface
) {
  const verify = (samples) =>
    verifyChecklistCases(getBrowser, openPage, setContent, select, press, readSurface, samples)
  it(
    'preserves complete paragraphs as tasks through native undo, redo and reload',
    () => verify(positiveCases),
    600_000
  )
  it(
    'keeps partial, structured and unsafe-literal task selections unchanged',
    () => verify(protectedCases),
    600_000
  )
}
