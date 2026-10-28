import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getPresentStringFlag } from '../../flags'
import {
  RuntimeClientError,
  type RuntimeClient,
  type RuntimeRpcSuccess
} from '../../runtime-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_START_CREATES_RUN_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { buildOrchestrationTaskDisplayMetadata } from '../../../shared/orchestration-task-display'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { isDevCliInvocation } from './runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import { formatWorkerStart } from './worker-output'
import { renderResolvedOrchestrationCommand } from '../../orchestration-mutation-recovery'

type WorkerStartResult = {
  runId: string
  taskId: string
  dispatchId: string
  state: string
  failedStage?: string
  lastError?: string
  warning?: string
  mode?: { mode: string; preferred: string; reason: string; detail: string }
  run?: { id: string; objective: string; created: boolean }
  effects: unknown[]
  residualResources: unknown[]
  nextCommands?: string[]
}

// Older runtimes refuse an unbound coordinator with exactly this; it also proves the caller works no Dispatch there.
const OLDER_RUNTIME_UNBOUND_COORDINATOR =
  'worker-start needs the coordinator bound to the Run, or a worker on an active Dispatch in it.'

/** Start a worker; against a runtime that cannot create the Run itself, run-create first as it would. */
async function startWorker(
  client: RuntimeClient,
  flags: Map<string, string | boolean>,
  params: { spec?: string; taskTitle?: string; run?: string; from?: string }
): Promise<RuntimeRpcSuccess<WorkerStartResult>> {
  try {
    return await callOrchestrationMutation<WorkerStartResult>(
      client,
      flags,
      'orchestration.workerStart',
      params
    )
  } catch (error) {
    const { spec } = params
    if (
      !spec ||
      params.run ||
      !(error instanceof RuntimeClientError) ||
      error.code !== 'consumer_fenced' ||
      error.message !== OLDER_RUNTIME_UNBOUND_COORDINATOR ||
      (await client.call<RuntimeStatus>('status.get')).result.capabilities?.includes(
        ORCHESTRATION_WORKER_START_CREATES_RUN_RUNTIME_CAPABILITY
      )
    ) {
      throw error
    }
    const { taskTitle: objective } = buildOrchestrationTaskDisplayMetadata({
      spec,
      taskTitle: params.taskTitle
    })
    const created = await callOrchestrationMutation<{ run: { id: string; objective: string } }>(
      client,
      new Map(),
      'orchestration.runCreate',
      { objective, from: params.from }
    )
    const started = await callOrchestrationMutation<WorkerStartResult>(
      client,
      flags,
      'orchestration.workerStart',
      params
    )
    return {
      ...started,
      result: { ...started.result, run: { ...created.result.run, created: true } }
    }
  }
}

export const ORCHESTRATION_WORKER_LAUNCH_HANDLER: Record<string, CommandHandler> = {
  'orchestration worker-start': async ({ flags, client, cwd, json }) => {
    const terminal = getPresentStringFlag(flags, 'terminal')
    const model = getOptionalStringFlag(flags, 'model')
    const effort = getOptionalStringFlag(flags, 'effort')
    if (model || effort) {
      const status = await client.call<RuntimeStatus>('status.get')
      if (
        !status.result.capabilities?.includes(
          ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
        )
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The connected Orca runtime does not support worker model or effort overrides. Update or restart Orca and try again.'
        )
      }
    }
    const task = getOptionalStringFlag(flags, 'task')
    const spec = getOptionalStringFlag(flags, 'spec')
    const taskTitle = getOptionalStringFlag(flags, 'task-title')
    const deps = getOptionalStringFlag(flags, 'deps')
    const parent = getOptionalStringFlag(flags, 'parent')
    const params = {
      task,
      ...(spec ? { spec } : {}),
      ...(taskTitle ? { taskTitle } : {}),
      ...(deps ? { deps } : {}),
      ...(parent ? { parent } : {}),
      on: getOptionalStringFlag(flags, 'on'),
      worktree: getOptionalStringFlag(flags, 'worktree'),
      name: getOptionalStringFlag(flags, 'name'),
      repo: getOptionalStringFlag(flags, 'repo'),
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      comment: getOptionalStringFlag(flags, 'comment'),
      setup: getOptionalStringFlag(flags, 'setup'),
      agent: getOptionalStringFlag(flags, 'agent'),
      model,
      effort,
      terminal,
      retryOf: getOptionalStringFlag(flags, 'retry-of'),
      timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client),
      devMode: isDevCliInvocation()
    }
    const result = await startWorker(client, flags, params)
    if (result.result.state !== 'ready') {
      process.exitCode = 1
    }
    const renderedResult = result.result.nextCommands
      ? {
          ...result,
          result: {
            ...result.result,
            nextCommands: result.result.nextCommands.map((command) =>
              renderResolvedOrchestrationCommand(command)
            )
          }
        }
      : result
    printResult(renderedResult, json, formatWorkerStart)
  }
}
