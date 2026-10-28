import {
  RpcOptionalBoolean,
  RpcString,
  RpcNonemptyString,
  RpcOptionalNonemptyString
} from './rpc-value-schemas'
import { z } from 'zod'
import { RepoSelector } from './github-repo-target-params'
import type { TuiAgent } from '../tui-agent'
import type { WorkspaceLaunchKind } from '../workspace-launch-kind'
import type { ProjectExecutionRuntimeResolution } from '../project-execution-runtime'

export const PreflightCheck = z.object({
  force: RpcOptionalBoolean
})

export const PreflightDetectRemoteAgents = z.object({
  connectionId: RpcNonemptyString
})

export const PreflightDetectRemoteWindowsTerminalCapabilities = z.object({
  connectionId: RpcNonemptyString
})

/** Why optional: a client that predates it sends nothing and keeps the host-default probe. */
export const PreflightAgentDetection = z.object({
  worktreeId: RpcOptionalNonemptyString,
  repoId: RpcOptionalNonemptyString
})

export const PreflightProjectAgentDetection = PreflightAgentDetection.extend({
  project: RepoSelector.extend({ repo: RepoSelector.shape.repo.pipe(RpcString.max(4096)) })
    .strict()
    .optional()
}).refine(
  (value) => !value.project || (!value.worktreeId && !value.repoId),
  'Choose project, repository or worktree'
)

/** Facts resolved by the same project owner that creates the workspace. */
export type ProjectLaunchContext = {
  agents: TuiAgent[]
  workspaceKind: WorkspaceLaunchKind
  executionContext:
    | { kind: 'host'; projectRuntime: ProjectExecutionRuntimeResolution }
    | { kind: 'ssh' }
}
