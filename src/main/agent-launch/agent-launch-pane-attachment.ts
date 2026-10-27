/** Use process-local launch state; after restart, ordinary pane attachment handles recovery. */

import type { TerminalForegroundPresentation } from '../../shared/terminal-foreground-presentation'
import type { RuntimePtyWorktreeRecord } from '../runtime/runtime-terminal-state-records'
import type { AgentLaunchPaneVerdict } from '../../shared/agent-launch-pane-verdict'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'

type LaunchBinding = Pick<
  RuntimePtyWorktreeRecord,
  'ptyId' | 'incarnationId' | 'pendingAgentLaunch'
>

const PROCEED: AgentLaunchPaneVerdict = { kind: 'proceed' }

export type AgentLaunchPane = { worktreeId: string; paneKey: string }

type RunningLaunch = {
  pane: AgentLaunchPane
  /** Unblock attachment when the agent binds or the launch ends, whichever happens first. */
  settled: Promise<AgentLaunchPaneVerdict>
  finished: Promise<AgentLaunchPaneVerdict>
  closedByUser: boolean
  attachmentFinished: boolean
  awaitingStart: boolean
  binding?: { id: string; incarnationId: string; record?: LaunchBinding }
  changed?: () => void
  owner: RunningAgentLaunchPane
}

const runningLaunchesByPane = new Map<string, RunningLaunch>()
const failedLaunchesByPane = new Map<
  string,
  { pane: AgentLaunchPane; verdict: AgentLaunchPaneVerdict }
>()

function paneKeyOf(pane: AgentLaunchPane): string {
  return JSON.stringify([pane.worktreeId, pane.paneKey])
}

export type RunningAgentLaunchPane = {
  /** Attach as soon as the agent binds, without waiting for prompt delivery. */
  agentBound(): void
  bind(id: string, incarnationId: string, record?: LaunchBinding): void
  presentation(state: TerminalForegroundPresentation | undefined, changed: () => void): typeof state
  forgetPresentation(): void
  finish(verdict: AgentLaunchPaneVerdict): void
  closedByUser(): boolean
}

/** Register before tab publication so immediately mounted panes wait for the launch. */
export function trackRunningAgentLaunchPane(
  pane: AgentLaunchPane,
  borrow = false
): RunningAgentLaunchPane {
  const key = paneKeyOf(pane)
  const previous = runningLaunchesByPane.get(key)
  if (borrow && previous && !previous.closedByUser && !previous.attachmentFinished) {
    return previous.owner
  }
  previous?.owner.forgetPresentation()
  let resolve!: (verdict: AgentLaunchPaneVerdict) => void
  let settle!: (verdict: AgentLaunchPaneVerdict) => void
  const owner: RunningAgentLaunchPane = {
    agentBound: () => settle(PROCEED),
    bind: (id, incarnationId, record) => {
      if (runningLaunchesByPane.get(key) !== running) {
        return
      }
      running.binding ??= { id, incarnationId }
      if (
        record &&
        running.awaitingStart &&
        running.binding.id === id &&
        running.binding.incarnationId === incarnationId
      ) {
        running.binding.record = record
        record.pendingAgentLaunch = owner
      }
    },
    presentation: (state, changed) => {
      if (!running.awaitingStart || runningLaunchesByPane.get(key) !== running) {
        return state
      }
      if (state !== 'agent-in-front') {
        running.changed = changed
        return undefined
      }
      running.awaitingStart = false
      owner.forgetPresentation()
      if (running.attachmentFinished) {
        runningLaunchesByPane.delete(key)
      }
      return state
    },
    forgetPresentation: () => {
      const record = running.binding?.record
      if (record?.pendingAgentLaunch === owner) {
        record.pendingAgentLaunch = undefined
      }
      if (running.binding) {
        running.binding.record = undefined
      }
      running.changed = undefined
    },
    finish: (verdict) => {
      if (running.attachmentFinished) {
        return
      }
      running.attachmentFinished = true
      if (runningLaunchesByPane.get(key) === running) {
        if (verdict.kind !== 'proceed' || !running.binding) {
          running.awaitingStart = false
        }
        if (!running.awaitingStart) {
          runningLaunchesByPane.delete(key)
        }
        if (
          !running.closedByUser &&
          (verdict.kind === 'not-started' || verdict.kind === 'unconfirmed')
        ) {
          failedLaunchesByPane.set(key, { pane, verdict })
        }
        if (!running.awaitingStart) {
          const changed = running.changed
          owner.forgetPresentation()
          changed?.()
        }
      }
      settle(verdict)
      resolve(verdict)
    },
    closedByUser: () => running.closedByUser
  }
  const running: RunningLaunch = {
    pane,
    settled: new Promise((done) => {
      settle = done
    }),
    finished: new Promise((done) => {
      resolve = done
    }),
    closedByUser: false,
    attachmentFinished: false,
    awaitingStart: true,
    owner
  }
  runningLaunchesByPane.set(key, running)
  failedLaunchesByPane.delete(key)
  return owner
}

/** `null` targets every pane of the workspace. */
function launchesIn<T extends { pane: AgentLaunchPane }>(
  launches: Map<string, T>,
  worktreeId: string,
  target: TerminalSurfaceCloseTarget | null
): T[] {
  return [...launches.values()].filter((launch) => {
    const pane = launch.pane.worktreeId === worktreeId ? parsePaneKey(launch.pane.paneKey) : null
    return (
      pane !== null &&
      (target === null ||
        (pane.tabId === target.tabId && (target.kind === 'tab' || pane.leafId === target.leafId)))
    )
  })
}

function runningLaunchesIn(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): RunningLaunch[] {
  return launchesIn(runningLaunchesByPane, worktreeId, target)
}

export function markAgentLaunchesClosedByUser(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): void {
  for (const running of runningLaunchesIn(worktreeId, target)) {
    running.closedByUser = true
    running.awaitingStart = false
    const changed = running.changed
    running.owner.forgetPresentation()
    runningLaunchesByPane.delete(paneKeyOf(running.pane))
    changed?.()
  }
  forgetFailedAgentLaunches(worktreeId, target)
}

/** Forget departed panes; null targets the entire workspace. */
export function forgetFailedAgentLaunches(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget | null
): void {
  for (const running of launchesIn(runningLaunchesByPane, worktreeId, target)) {
    running.awaitingStart = false
    runningLaunchesByPane.delete(paneKeyOf(running.pane))
    const changed = running.changed
    running.owner.forgetPresentation()
    changed?.()
  }
  for (const failed of launchesIn(failedLaunchesByPane, worktreeId, target)) {
    failedLaunchesByPane.delete(paneKeyOf(failed.pane))
  }
}

export function listFailedAgentLaunchWorktreeIds(): string[] {
  return [...failedLaunchesByPane.values()].map((failed) => failed.pane.worktreeId)
}

/** Only the owning launch may spawn into a reserved pane. */
export function isAgentLaunchRunningIn(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): boolean {
  return runningLaunchesIn(worktreeId, target).some((launch) => !launch.attachmentFinished)
}

/** Live processes and persisted bindings both qualify for adoption. */
export type IsAgentLaunchPaneLive = (paneKey: string) => boolean

async function settleVerdict(
  pane: AgentLaunchPane,
  isPaneLive: IsAgentLaunchPaneLive
): Promise<AgentLaunchPaneVerdict> {
  let verdict = failedLaunchesByPane.get(paneKeyOf(pane))?.verdict ?? PROCEED
  // A retry can replace the launch in this pane while we await its verdict.
  for (
    let running = runningLaunchesByPane.get(paneKeyOf(pane));
    running && !running.attachmentFinished;
    running = runningLaunchesByPane.get(paneKeyOf(pane))
  ) {
    if ((await running.settled).kind === 'withdrawn') {
      return { kind: 'withdrawn' }
    }
    if (isPaneLive(pane.paneKey)) {
      return PROCEED
    }
    verdict = await running.finished
    if (verdict.kind === 'withdrawn') {
      return verdict
    }
  }
  if (!isPaneLive(pane.paneKey)) {
    return verdict
  }
  failedLaunchesByPane.delete(paneKeyOf(pane))
  return PROCEED
}

/** Return null synchronously for ordinary panes so their spawn timing stays unchanged. */
export function resolveAgentLaunchPaneVerdict(
  pane: AgentLaunchPane,
  isPaneLive: IsAgentLaunchPaneLive
): Promise<AgentLaunchPaneVerdict> | null {
  const key = paneKeyOf(pane)
  return (runningLaunchesByPane.has(key) && !runningLaunchesByPane.get(key)?.attachmentFinished) ||
    failedLaunchesByPane.has(key)
    ? settleVerdict(pane, isPaneLive)
    : null
}

/** Registration addresses the existing pane token once; paid reads follow that exact binding. */
export function bindAgentLaunchPresentation(pane: AgentLaunchPane, record: LaunchBinding): void {
  if (record.incarnationId) {
    runningLaunchesByPane
      .get(paneKeyOf(pane))
      ?.owner.bind(record.ptyId, record.incarnationId, record)
  }
}

export function resetAgentLaunchPanesForTests(): void {
  for (const running of runningLaunchesByPane.values()) {
    running.owner.forgetPresentation()
  }
  runningLaunchesByPane.clear()
  failedLaunchesByPane.clear()
}
