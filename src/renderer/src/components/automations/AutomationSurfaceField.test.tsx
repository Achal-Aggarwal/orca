// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AutomationDraft } from './AutomationEditorDialog'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AutomationSurfaceField } from './AutomationSurfaceField'
import { automationDraftSurface } from './automation-launch-surface'
import { buildAutomationEditDraft } from './automation-edit-draft'
import { buildProfileStateCutoverFixture } from '../../../../main/persistence/profile-state-cutover-fixture'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this pure control reads only the default switch and selected agent/surface.
const settings = { experimentalNativeChat: true } as GlobalSettings
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unrelated editor fields are never read by this control.
const draft = { agentId: 'claude', extraAgentArgs: '--model opus' } as AutomationDraft
afterEach(cleanup)
it('places the current default on the right, highlights it, and preserves arguments through toggles', () => {
  const change = vi.fn()
  render(
    <AutomationSurfaceField
      draft={draft}
      settings={settings}
      supported
      groupClassName=""
      itemClassName=""
      onDraftChange={change}
    />
  )
  const radios = screen.getAllByRole('radio')
  expect(radios.map((radio) => radio.textContent)).toEqual(['Terminal', 'Chat'])
  expect(radios[1].getAttribute('aria-checked')).toBe('true')
  fireEvent.click(radios[0])
  expect(change.mock.calls[0][0](draft)).toMatchObject({
    surface: 'terminal',
    extraAgentArgs: '--model opus'
  })
})
it('keeps legacy automations Terminal when the current default is Chat', () => {
  const legacy = buildAutomationEditDraft(
    buildProfileStateCutoverFixture('/fixture').automations[0]
  )
  expect(legacy.surface).toBe('terminal')
  expect(automationDraftSurface(legacy, settings, true)).toBe('terminal')
})
it('reserves disabled controls until host support is known and hides Chat on unsupported hosts', () => {
  const props = { draft, settings, groupClassName: '', itemClassName: '', onDraftChange: vi.fn() }
  const view = render(<AutomationSurfaceField {...props} supported={null} />)
  expect(screen.getAllByRole('radio').every((radio) => radio.hasAttribute('disabled'))).toBe(true)
  view.rerender(<AutomationSurfaceField {...props} supported={false} />)
  expect(screen.queryByRole('radio')).toBeNull()
})
