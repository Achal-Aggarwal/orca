import { OrcaRuntimeWithCreateWorkspaceTerminal } from './terminal-create-workspace'
import * as dependencies from '../../orca-runtime-create-terminal-dependencies'
import { createDesktopTerminal } from '../../orca-runtime-create-terminal-desktop'
export abstract class OrcaRuntimeWithCreateTerminal extends OrcaRuntimeWithCreateWorkspaceTerminal {
  async createTerminal(
    worktreeSelector?: string,
    opts: dependencies.TerminalCreateOptions = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    created?: dependencies.Worktree
  ): Promise<dependencies.RuntimeTerminalCreate> {
    if (opts.startupAgent && worktreeSelector === undefined) {
      throw new Error(`startupAgent ${opts.startupAgent} requires a workspace selector.`)
    }
    const callerColors = dependencies.normalizeColorQueryReplyColors(opts.terminalColorQueryReplies)
    // Older paired clients report their theme only at creation.
    if (callerColors) {
      dependencies.setPairedViewerColors(callerColors)
    }
    const presentation = dependencies.resolveTerminalPresentation(opts)
    // Start host-placeable terminals here; timing out a window-made start still ran it later and retries duplicated it.
    if (worktreeSelector !== undefined) {
      return this.createWorkspaceTerminal(worktreeSelector, opts, presentation, created)
    }
    // The renderer owns this spawn, so this process cannot see when it is requested.
    opts.onPtySpawnDispatched?.()
    return createDesktopTerminal(this, opts, presentation)
  }
}
