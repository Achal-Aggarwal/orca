import { expect } from 'vitest'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import type { ChatInstall, ChatLane } from './wsl-orcad-structured-chat-contract'

/** Guest file the Windows-side `claude` decoy appends to each time anything runs it. */
export const WSL_CHAT_DECOY_MARKER = 'orca-lane-claude-decoy-ran'

/** Windows dir (under the lane's work dir) the lane puts on its own PATH, which WSL appends to orcad's. */
export const WSL_CHAT_WINDOWS_DECOY_DIR = 'windows-claude-install'

/** A Windows install as WSL interop exposes it: an npm-style `claude` sh shim on the Windows PATH. */
export const WSL_CHAT_WINDOWS_DECOY = [
  '#!/bin/sh',
  `printf '%s\\n' "$0" >> "$HOME/${WSL_CHAT_DECOY_MARKER}"`,
  `[ "$1" = --version ] && { echo '2.1.258 (Claude Code)'; exit 0; }`,
  'exit 1',
  ''
].join('\n')

async function decoyRuns(lane: ChatLane, home: string): Promise<string[]> {
  const marker = quotePosixShell(`${home}/${WSL_CHAT_DECOY_MARKER}`)
  return (await lane.guest(`cat ${marker} 2>/dev/null || true`)).split('\n').filter(Boolean)
}

/** A guest install ahead of WSL's appended Windows PATH must keep the Windows one unrun. */
export async function expectWindowsDecoyUnrun(lane: ChatLane, home: string): Promise<void> {
  expect(await decoyRuns(lane, home)).toEqual([])
}

/** With no guest install left, whether orcad runs the Windows-side `claude` WSL interop exposes. */
export async function probeWindowsDecoy(lane: ChatLane, install: ChatInstall, worktree: string) {
  const interopPath = (
    await lane.guest(
      `tr '\\0' '\\n' < /proc/${lane.runtimePid}/environ | sed -n 's/^PATH=//p' | tr ':' '\\n' | grep '^/mnt/' || true`
    )
  )
    .split('\n')
    .filter(Boolean)
  await lane.guest(`rm -f ${quotePosixShell(install.cli)}`)
  let support: unknown = null
  let runs: string[] = []
  // The shell env refreshes on a miss or after its TTL; poll past both.
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    support = await lane.rpc('agentSession.createSupport', {
      worktree,
      agent: 'claude'
    })
    runs = await decoyRuns(lane, install.home)
    if (runs.length > 0) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  return {
    orcadInteropPathEntries: interopPath.length,
    decoyOnOrcadPath: interopPath.some((entry) => entry.endsWith(`/${WSL_CHAT_WINDOWS_DECOY_DIR}`)),
    support,
    decoyRuns: runs
  }
}
