import { afterAll, expect, it, vi } from 'vitest'
import {
  realKimiPrOutput,
  realKimiOccupiedOutput,
  sourceShapedKimiOutput
} from '../../shared/__fixtures__/kimi-generation-source-shaped'
import type * as DnsDiagnosticModule from '../network/macos-tailscale-dns-diagnostic'
import { finalizeFromAgentOutput } from './source-control-agent-failure'

const log = vi.spyOn(console, 'error').mockImplementation(() => {})
afterAll(() => log.mockRestore())
vi.mock('../network/macos-tailscale-dns-diagnostic', async (original) => {
  const actual = await original<typeof DnsDiagnosticModule>()
  return {
    ...actual,
    withMacTailscaleDnsHint: (message: string, detail?: string | null) =>
      actual.withMacTailscaleDnsHintForDiagnostic(message, detail, {
        globalNameservers: ['100.100.100.100']
      })
  }
})
const invalid = /Kimi returned output Orca couldn't read\. Try again\./
const occupied = /Kimi.*active in another client.*Stop.*exit.*try again/
const unknown = /^Kimi couldn't finish.*execution host.*check.*retrying/
const earlier = sourceShapedKimiOutput('Earlier answer')
const network = 'provider.connection_error: getaddrinfo ENOTFOUND private-host'

// Source-shaped stderr forms come from the official 2.3.1 terminal error routes.
it.each([
  ['occupied', occupied, realKimiOccupiedOutput, 4],
  ['unrelated private-prose', occupied, `${earlier}\n${realKimiOccupiedOutput}`, 4],
  ['Session "private-session" not found.', /find.*session.*existing session.*new one/],
  [
    'Session "private-session" was created under a different directory.',
    /another directory.*Resume it there.*workspace/
  ],
  [
    'no provider configured; complete onboarding via /login or the providers endpoint',
    /credentials.*execution host.*configure.*sign in/
  ],
  [
    'Provider "private-provider" declares api_key_env = "PRIVATE_ENV" in config.toml, but the environment variable is not set or is empty.',
    /credential environment variable.*Set it.*execution host/
  ],
  [
    'model private-model does not resolve to a configured provider',
    /usable model.*configure or select/
  ],
  ['Prompt hook blocked the request.', /hook blocked.*Review.*hooks.*retry/],
  ['Prompt turn ended with reason: cancelled', /cancelled.*Try again/],
  [
    'provider.auth_error: private-provider prose',
    /authenticate.*Sign in.*credentials.*retry/,
    '{broken'
  ],
  [network, /connect.*network.*retry(?!.*MagicDNS)/],
  [network, /connect.*network.*MagicDNS/, '', 1, true],
  ['provider.rate_limit: private-provider prose', /limit.*Wait.*reduce/],
  ['Provider safety policy blocked the response.', /blocked.*Revise.*prompt.*configuration/],
  ['context.overflow: private-provider prose', /context.*Shorten.*new session/],
  ['config.invalid: private-provider prose', /invalid configuration.*Check.*model.*provider/],
  ['Prompt cannot be empty.', /empty prompt.*recipe.*CLI arguments/],
  ['Cannot combine --prompt with --auto.', /conflicting.*--prompt.*--auto.*recipe.*arguments/],
  [
    'Cannot combine --agent/--agent-file with --session/--continue: the agent is bound at session creation and the bound agent is restored automatically on resume.',
    /cannot change the agent.*Remove.*override.*new session/
  ],
  ['Cannot use --session without an id in prompt mode.', /session id.*recipe.*arguments/],
  ['Output format is only supported in prompt mode.', /format.*prompt mode.*supported.*recipe/],
  ['unrecognized private-prose CODE_SECRET', unknown, '{broken'],
  ['hook narration provider.auth_error: private-prose', unknown],
  ['', /Kimi.*interrupted.*Try again/, '', null],
  ['', invalid, realKimiOccupiedOutput, 0],
  [
    'provider.auth_error: private-prose',
    /Kimi returned an empty message\.$/,
    sourceShapedKimiOutput(),
    0
  ],
  ['captured success', /"title":"Decode Kimi generation output.*\\n\\n/, realKimiPrOutput, 0],
  ...[
    '{"role":',
    'NOTICE wrapper log',
    '{"role":"assistant","content":42}',
    '{"role":"assistant","tool_calls":"bad"}',
    '{"role":"tool","content":"missing id"}'
  ].map((bad) => ['damaged success', invalid, `${earlier}\n${bad}`, 0] as const)
] as const)(
  '%s outcome',
  (source, meaning, stdout = '{"type":"error","code":"unknown.code"}', code = 1, local = false) => {
    const stderr =
      source === 'occupied' || !source
        ? ''
        : `error: failed to run prompt: ${source}\nSee log: private-path`
    const result = finalizeFromAgentOutput({
      stdout,
      stderr,
      code,
      includeLocalMacDnsHint: local,
      label: 'Kimi',
      emptyResultName: 'message',
      outputFormat: 'kimi-stream-json'
    })
    expect(result.success).toBe(source === 'captured success')
    const text = result.success ? result.rawOutput : result.error
    expect(text).toMatch(meaning)
    expect(text).not.toMatch(
      /private-|PRIVATE_ENV|CODE_SECRET|provider\.[a-z_]+|session\.occupied|unknown\.code|code [014]/
    )
    if (!local) {
      expect(text).not.toContain('MagicDNS')
    }
    if (!result.success && (stdout || stderr)) {
      expect(result.failureOutput).toEqual({ label: 'Kimi', exitCode: code, stdout, stderr })
    }
  }
)
