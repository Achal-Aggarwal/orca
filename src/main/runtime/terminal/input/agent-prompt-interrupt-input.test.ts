import { expect, it, vi } from 'vitest'
import { TerminalRunFactsRegister } from '../../terminal-run-facts'
import { agentPromptInterruptInput } from './agent-prompt-interrupt-input'

it.each([10, 100])('frames input with %i scoped prompt observers and releases them', (count) => {
  const facts = new TerminalRunFactsRegister(),
    interrupted = vi.fn()
  const releases = Array.from({ length: count }, (_, i) =>
    facts.onInputBytes(`pty-${i}`, agentPromptInterruptInput(interrupted))
  )
  const corpus =
    `a\x03|\r\x03|\x1b|[20|0~${'paste\x03'.repeat(1_000)}|\x1b[201~|\x1bx\x03|\x1b[200~a\x03\x1b[201~\x03`.split(
      '|'
    )
  const start = performance.now()
  corpus.forEach((data) => facts.recordInput('pty-0', 'driving', data))
  expect(interrupted).toHaveBeenCalledTimes(4)
  expect(performance.now() - start).toBeLessThan(1_000)
  releases.forEach((release) => release())
  corpus.forEach((data) => facts.recordInput('pty-0', 'driving', data))
  facts.recordInput('unrelated', 'driving', '\x03')
  expect(interrupted).toHaveBeenCalledTimes(4)
})
