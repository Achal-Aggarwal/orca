import { stripAnsiControlSequences } from '../../shared/commit-message-agent-output'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'

export function formatKimiGenerationFailure(
  declared: string | null,
  stderr: string,
  code: number | null,
  options: { includeLocalMacDnsHint?: boolean }
): string {
  if (declared) {
    return declared
  }
  const message =
    stderrDiagnosis(stripAnsiControlSequences(stderr)) ??
    (code === null
      ? 'Kimi was interrupted before it finished generating text. Try again.'
      : "Kimi couldn't finish generating text. Open Kimi on the execution host to check the failure before retrying.")
  return options.includeLocalMacDnsHint === false
    ? message
    : withMacTailscaleDnsHint(message, stderr)
}

function stderrDiagnosis(stderr: string): string | null {
  // Only the CLI's terminal error lines select copy; hook narration is not a diagnosis.
  for (const line of stderr.split(/\r?\n/)) {
    const terminal = /^error: (?:failed to run prompt: )?(.+)$/.exec(line)?.[1]
    if (!terminal) {
      continue
    }
    if (/^Session "[^"\r\n]*" not found\.$/.test(terminal) || terminal === 'Session not found') {
      return "Kimi couldn't find the requested session. Use an existing session or start a new one."
    }
    if (/^Session "[^"\r\n]*" was created under a different directory\.$/.test(terminal)) {
      return 'This Kimi session belongs to another directory. Resume it there or use a session created for this workspace.'
    }
    if (
      /^Provider "[^"\r\n]*" declares api_key_env = "[^"\r\n]*" in config\.toml, but the environment variable is not set or is empty\.$/.test(
        terminal
      )
    ) {
      return 'Kimi is missing a configured credential environment variable. Set it on the execution host before retrying.'
    }
    if (
      terminal ===
        'no provider configured; complete onboarding via /login or the providers endpoint' ||
      /^provider .+ has no credential configured$/.test(terminal) ||
      terminal === 'Login required'
    ) {
      return 'Kimi needs provider credentials. Open Kimi on the execution host to configure a provider or sign in, then retry.'
    }
    if (
      terminal === 'no default model configured' ||
      /^model .+ does not resolve to a configured provider$/.test(terminal) ||
      terminal.startsWith('No model configured. Run `kimi` and use /login') ||
      terminal === 'No model configured' ||
      terminal === 'Invalid model configuration'
    ) {
      return 'Kimi has no usable model configured. Open Kimi on the execution host to configure or select a model, then retry.'
    }
    if (
      terminal === 'Prompt hook blocked the request.' ||
      terminal === 'Prompt turn could not be started'
    ) {
      return "A Kimi prompt hook blocked the request or the turn couldn't start. Review Kimi hooks and configuration before retrying."
    }
    if (terminal === 'Prompt turn ended with reason: cancelled') {
      return 'Kimi cancelled the request before it finished generating text. Try again.'
    }
    if (/^(?:Prompt|Model|Agent|Agent file path) cannot be empty\.$/.test(terminal)) {
      const input = terminal.slice(0, terminal.indexOf(' cannot'))
      return `Kimi received an empty ${input.toLowerCase()}. Correct that input in the generation recipe or CLI arguments, then retry.`
    }
    if (
      terminal === 'Output format is only supported in prompt mode.' ||
      /^Invalid KIMI_MODEL_OUTPUT_FORMAT value "[^"\r\n]*"\. Expected one of: text, stream-json\.$/.test(
        terminal
      )
    ) {
      return 'Kimi output format requires prompt mode and a supported text or stream-json value. Correct the generation recipe or CLI arguments before retrying.'
    }
    if (terminal === '--agent-file may only be specified once.') {
      return 'Kimi received multiple agent files. Keep one agent file in the generation recipe or CLI arguments, then retry.'
    }
    if (terminal === 'Cannot use --session without an id in prompt mode.') {
      return 'Kimi needs a session id to resume in prompt mode. Correct the generation recipe or CLI arguments, then retry.'
    }
    const conflict =
      /^Cannot combine (--prompt with --(?:yolo|auto|plan)|--agent with --agent-file|--continue, --session|--yolo with --auto)\.$/.exec(
        terminal
      )?.[1]
    if (conflict) {
      return `Kimi received conflicting options: ${conflict}. Correct the generation recipe or CLI arguments before retrying.`
    }
    if (
      terminal ===
      'Cannot combine --agent/--agent-file with --session/--continue: the agent is bound at session creation and the bound agent is restored automatically on resume.'
    ) {
      return 'Kimi cannot change the agent when resuming a session. Remove the agent override or start a new session in the generation recipe or CLI arguments.'
    }
    if (
      terminal === 'Provider safety policy blocked the response.' ||
      terminal === 'Provider filtered response'
    ) {
      return 'Kimi could not return a response because it was blocked. Revise the prompt or model configuration before retrying.'
    }
    const category =
      /^(provider\.[a-z_]+|context\.overflow|config\.invalid):(?: |$)/.exec(terminal)?.[1] ??
      terminal
    switch (category) {
      case 'provider.auth_error':
      case 'Provider authentication error':
        return 'Kimi could not authenticate. Sign in or correct provider credentials on the execution host, then retry.'
      case 'provider.connection_error':
      case 'Provider connection error':
        return 'Kimi could not connect to its provider. Check the network on the execution host, then retry.'
      case 'provider.rate_limit':
      case 'provider.overloaded':
      case 'Provider rate limit':
        return 'Kimi reached a provider limit or the provider is busy. Wait before retrying or reduce request frequency.'
      case 'context.overflow':
      case 'Context window overflow':
        return 'Kimi ran out of context. Shorten the prompt or start a new session, then retry.'
      case 'config.invalid':
      case 'Invalid configuration':
        return 'Kimi has invalid configuration. Check the model and provider configuration on the execution host before retrying.'
    }
  }
  return null
}
