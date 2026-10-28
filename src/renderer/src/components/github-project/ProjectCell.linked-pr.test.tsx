// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import ProjectViewList from './ProjectViewList'
import { linkedPullRequestsRow, linkedPullRequestsTable } from './ProjectCell.test-fixture'

afterEach(cleanup)

it('opens exact linked PR URLs with native activation and preserves the issue title action', async () => {
  const user = userEvent.setup()
  const pullRequests = [
    { number: 93, title: 'Origin PR', url: 'https://github.com/fork/widgets/pull/93' },
    { number: 93, title: 'Upstream PR', url: 'https://github.com/upstream/widgets/pull/93' },
    { number: 93, title: 'Enterprise PR', url: 'https://github.example.com/fork/widgets/pull/93' }
  ]
  const row = {
    ...linkedPullRequestsRow,
    content: {
      ...linkedPullRequestsRow.content,
      linkedPullRequests: { pullRequests, totalCount: 3 }
    }
  }
  const openUrl = vi.fn().mockResolvedValue(undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  const onOpenDialog = vi.fn()
  const rowClick = vi.fn()
  const rowKeyDown = vi.fn()
  render(
    <TooltipProvider>
      <div onClick={rowClick} onKeyDown={rowKeyDown}>
        <ProjectViewList
          table={{ ...linkedPullRequestsTable, rows: [row] }}
          sourceTarget={{ kind: 'local' }}
          onOpenDialog={onOpenDialog}
        />
      </div>
    </TooltipProvider>
  )
  const title = screen.getByRole('button', { name: `#7 ${row.content.title}` })
  const buttons = screen.getAllByRole('button', { name: '#93' })
  buttons[0].focus()
  await user.tab()
  expect(document.activeElement).toBe(buttons[1])
  await user.tab({ shift: true })
  expect(document.activeElement).toBe(buttons[0])
  rowKeyDown.mockClear()
  for (const [index, pr] of pullRequests.entries()) {
    const button = buttons[index]
    await user.hover(button)
    expect(button.getAttribute('title')).toBe(pr.title)
    await user.click(button)
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(openUrl.mock.calls.slice(index * 3)).toEqual([[pr.url], [pr.url], [pr.url]])
  }
  expect(openUrl).toHaveBeenCalledTimes(9)
  expect(onOpenDialog).not.toHaveBeenCalled()
  expect(rowClick).not.toHaveBeenCalled()
  expect(rowKeyDown).not.toHaveBeenCalled()
  expect(buttons[0].parentElement?.textContent).toBe('#93, #93, #93')
  expect(screen.queryByRole('button', { name: /more linked pull requests/ })).toBeNull()
  await user.click(title)
  expect(onOpenDialog).toHaveBeenCalledExactlyOnceWith(row)
  expect(openUrl).toHaveBeenCalledTimes(9)
})

it('opens the original issue URL from linked PR overflow without activating the row', async () => {
  const user = userEvent.setup()
  const openUrl = vi.fn().mockResolvedValue(undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  const onOpenDialog = vi.fn()
  const rowEvent = vi.fn()
  render(
    <TooltipProvider>
      <div onClick={rowEvent} onKeyDown={rowEvent}>
        <ProjectViewList
          table={linkedPullRequestsTable}
          sourceTarget={{ kind: 'local' }}
          onOpenDialog={onOpenDialog}
        />
      </div>
    </TooltipProvider>
  )
  const overflow = screen.getByRole('button', { name: '2 more linked pull requests' })
  expect(overflow.textContent).toBe('+2')
  await user.hover(overflow)
  expect((await screen.findByRole('tooltip')).textContent).toBe('2 more linked pull requests')
  await user.click(overflow)
  expect(document.activeElement).toBe(overflow)
  await user.keyboard('{Enter}')
  await user.keyboard(' ')
  expect(openUrl.mock.calls).toEqual(
    Array.from({ length: 3 }, () => [linkedPullRequestsTable.rows[1].content.url])
  )
  expect(onOpenDialog).not.toHaveBeenCalled()
  expect(rowEvent).not.toHaveBeenCalled()
})

it('keeps loaded PRs without overflow navigation when the item URL is missing', () => {
  const overflowRow = linkedPullRequestsTable.rows[1]
  render(
    <TooltipProvider>
      <ProjectViewList
        table={{
          ...linkedPullRequestsTable,
          rows: [{ ...overflowRow, content: { ...overflowRow.content, url: null } }]
        }}
        sourceTarget={{ kind: 'local' }}
      />
    </TooltipProvider>
  )
  expect(screen.getAllByRole('button', { name: /^#\d+$/ })).toHaveLength(10)
  expect(screen.queryByRole('button', { name: /more linked pull requests/ })).toBeNull()
})
