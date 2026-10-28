import { expect, it } from 'vitest'

const readTheme = (page) =>
  page.evaluate(() => {
    const selection = window.getSelection()
    return {
      scheme: document.getElementById('orca-rich-markdown-document-style').dataset.scheme,
      sheets: document.querySelectorAll('#orca-rich-markdown-document-style').length,
      changes: [...globalThis.__orcaEditor.changes],
      secondChanges: [...globalThis.__orcaEditor.secondChanges],
      selection: {
        text: selection.toString(),
        anchorOffset: selection.anchorOffset,
        focusOffset: selection.focusOffset,
        sameAnchor: selection.anchorNode === globalThis.__themeAnchor,
        sameFocus: selection.focusNode === globalThis.__themeFocus
      },
      surfaces: Array.from(document.querySelectorAll('#editor'), (editor, index) => {
        const style = getComputedStyle(editor)
        return {
          styled: editor.parentElement.classList.contains('orca-rich-markdown-document-host'),
          sameSurface: editor === globalThis.__themeEditors[index],
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          listStyle: getComputedStyle(editor.querySelector('ul')).listStyleType,
          paragraphMargin: getComputedStyle(editor.querySelector('li > div > p')).marginTop,
          html: editor.innerHTML.replaceAll(' style=""', ''),
          color: style.color,
          background: getComputedStyle(editor.parentElement).backgroundColor
        }
      })
    }
  })

async function setScheme(page, scheme) {
  await page.evaluate((next) => globalThis.__orcaEditor.setScheme(next), scheme)
  await page.waitForFunction(
    (next) => document.getElementById('orca-rich-markdown-document-style').dataset.scheme === next,
    scheme
  )
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

async function prepareTheme(page, { both, editable, scheme }) {
  await setScheme(page, scheme)
  await page.evaluate(
    ({ both, editable }) =>
      globalThis.__orcaEditor.set({
        both,
        editable,
        content: 'Before\n\n- [ ] Open task\n- [x] Completed task\n\nAfter',
        secondContent: '- [ ] Second task\n- [x] Completed second task'
      }),
    { both, editable }
  )
  await page.waitForFunction(
    (count) => document.querySelectorAll('#editor ul[data-type="taskList"]').length === count,
    both ? 2 : 1
  )
  if (editable) {
    await page.locator('#first-surface #editor p').last().click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
  }
  await page.evaluate(() => {
    globalThis.__themeEditors = Array.from(document.querySelectorAll('#editor'))
    const text = document.querySelector('#first-surface #editor p').firstChild
    const range = document.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 4)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    globalThis.__themeAnchor = selection.anchorNode
    globalThis.__themeFocus = selection.focusNode
  })
  return readTheme(page)
}

export function themeSwitchTest(getBrowser, openPage, fontFloor) {
  it.each([false, true])(
    'retains mounted editor styling and selection through scheme changes (overlap %s)',
    async (both) => {
      for (const editable of [true, false]) {
        for (const initial of ['dark', 'light']) {
          const { page, consoleErrors } = await openPage(getBrowser())
          try {
            const before = await prepareTheme(page, { both, editable, scheme: initial })
            let previous = before
            for (const scheme of [initial === 'dark' ? 'light' : 'dark', initial]) {
              await setScheme(page, scheme)
              const after = await readTheme(page)
              expect(after.scheme).toBe(scheme)
              expect(after.sheets).toBe(1)
              expect(after.changes).toEqual(before.changes)
              expect(after.secondChanges).toEqual(before.secondChanges)
              expect(after.selection).toEqual(before.selection)
              expect(after.surfaces).toHaveLength(both ? 2 : 1)
              for (const [index, surface] of after.surfaces.entries()) {
                const { color, background } = surface
                expect({ ...surface, color: null, background: null }).toEqual({
                  ...before.surfaces[index],
                  color: null,
                  background: null
                })
                expect(surface.styled).toBe(true)
                expect(surface.sameSurface).toBe(true)
                expect(Number.parseFloat(surface.fontSize)).toBeGreaterThanOrEqual(fontFloor)
                expect(surface.listStyle).toBe('none')
                expect(color).not.toBe(previous.surfaces[index].color)
                expect(background).not.toBe(previous.surfaces[index].background)
              }
              previous = after
            }
            if (editable) {
              await page.evaluate(() => document.querySelector('#first-surface #editor').focus())
              const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
              await page.keyboard.press(`${modifier}+z`)
              await page.waitForFunction(() =>
                document.querySelector('#first-surface #editor').textContent.endsWith('After')
              )
              await page.keyboard.press(`${modifier}+Shift+z`)
              await page.waitForFunction(() =>
                document.querySelector('#first-surface #editor').textContent.endsWith('After!')
              )
            }
            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
          } finally {
            await page.close()
          }
        }
      }
    },
    180_000
  )
}
