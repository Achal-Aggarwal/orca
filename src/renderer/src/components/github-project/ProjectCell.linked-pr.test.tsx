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
      linkedPullRequests: { pullRequests, totalCount: 5 }
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
  expect(buttons[0].parentElement?.textContent).toBe('#93, #93, #93 +2')
  expect(screen.getByText(/\+2/).closest('button')).toBeNull()
  await user.click(title)
  expect(onOpenDialog).toHaveBeenCalledExactlyOnceWith(row)
  expect(openUrl).toHaveBeenCalledTimes(9)
})
