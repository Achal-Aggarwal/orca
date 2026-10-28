import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { planCommitMessageGeneration } from '../../shared/commit-message-plan'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'
import { runLocalSourceControlPlan } from './source-control-local-process'
import {
  createMockDiscoveryChild,
  withPlatform
} from './commit-message-text-generation-test-harness'

vi.mock('../windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: vi.fn(async () => true)
}))

afterEach(() => vi.useRealTimers())

// OMP 17.0.5 recorded stdin-only execution: exit 0, empty stdout/stderr, no submitted prompt.
const recordedPrompt = `Name this chat from the user's first request.
Write a short, specific title of at most 48 characters.
Output only the title, with no heading, quotes, or explanation.

First request:
Trace a lost lighthouse signal.

Additional instructions:
Return Lighthouse Signal Trace.
`

it.each(['success', 'failure', 'cancel', 'timeout', 'spawn failure'] as const)(
  'delivers the recorded OMP prompt without stdin and removes the owned file after %s',
  async (outcome) => {
    vi.useFakeTimers()
    const prompt = recordedPrompt + 'x'.repeat(200_000)
    const planned = planCommitMessageGeneration({ agentId: 'omp', model: 'default' }, prompt)
    if (!planned.ok) {
      throw new Error(planned.error)
    }
    const child = createMockDiscoveryChild()
    let promptPath = ''
    const execution = withPlatform('win32', () =>
      runLocalSourceControlPlan({
        plan: planned.plan,
        cwd: '/omp-file-test',
        env: undefined,
        operation: 'conversation-name',
        emptyResultName: 'chat name',
        spawnAgent: ({ args }) => {
          promptPath = args[planned.plan.promptFile?.argIndex ?? -1]?.slice(1) ?? ''
          expect(readFileSync(promptPath, 'utf8')).toBe(prompt)
          expect(args.join(' ').length).toBeLessThan(1000)
          if (outcome === 'spawn failure') {
            throw new Error('recorded spawn failure')
          }
          return child
        }
      })
    )
    if (outcome === 'success') {
      // Like the recorded binary, this child never reads stdin; only the explicit file submits input.
      child.stdout.emit('data', Buffer.from('Lighthouse Signal Trace'))
    } else if (outcome === 'cancel') {
      cancelLocalGeneration('conversation-name', '/omp-file-test')
    } else if (outcome === 'timeout') {
      await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
    }
    if (outcome !== 'spawn failure') {
      expect(child.stdin.end).toHaveBeenCalledWith(undefined)
      expect(existsSync(promptPath)).toBe(true)
      child.emit('close', outcome === 'failure' ? 1 : 0)
    }
    const result = await execution.result
    await execution.processClosed
    expect(result.success).toBe(outcome === 'success')
    expect(existsSync(dirname(promptPath))).toBe(false)
  }
)
