/**
 * @vitest-environment happy-dom
 *
 * STA-3811: imports never touch the Google cookie family, so every import menu must disclose it
 * at the moment of decision.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/dropdown-menu', () => dropdownMenuStubs())
vi.mock('../ui/dropdown-menu', () => dropdownMenuStubs())
import { BrowserCookieImportDisclosure } from './BrowserCookieImportDisclosure'
describe('cookie-import Google disclosure footer', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders an icon after the footer separator', () => {
    act(() => root.render(<BrowserCookieImportDisclosure />))

    const label = container.querySelector('[data-testid="dropdown-menu-label"]')
    expect(label?.querySelector('svg')).not.toBeNull()
    expect(label?.previousElementSibling?.tagName).toBe('HR')
  })
})

function dropdownMenuStubs(): Record<string, unknown> {
  const passthrough = ({ children }: { children?: ReactNode }): ReactNode => children
  const block = ({ children }: { children?: ReactNode }): ReactNode => <div>{children}</div>
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: block,
    DropdownMenuItem: block,
    DropdownMenuLabel: ({ children }: { children?: ReactNode }): ReactNode => (
      <div data-testid="dropdown-menu-label">{children}</div>
    ),
    DropdownMenuPortal: passthrough,
    DropdownMenuRadioGroup: passthrough,
    DropdownMenuRadioItem: block,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuShortcut: block,
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: block,
    DropdownMenuSubTrigger: block,
    DropdownMenuTrigger: passthrough
  }
}
