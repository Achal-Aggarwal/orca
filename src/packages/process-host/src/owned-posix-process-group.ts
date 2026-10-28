import type { ChildProcess } from 'node:child_process'
import {
  forceTerminateProcessTree,
  posixProcessGroupExists,
  signalProcessTree
} from './process-tree-termination'

const PROCESS_GROUP_EXIT_GRACE_MS = 2_000

export type OwnedPosixProcessGroup = {
  terminated: Promise<void>
  stop: (signal?: NodeJS.Signals) => Promise<boolean>
}

type ProcessGroupChild = Pick<ChildProcess, 'pid'>

const owners = new WeakMap<ProcessGroupChild, OwnedPosixProcessGroup>()

export function ownedPosixProcessGroup(
  child: ProcessGroupChild
): OwnedPosixProcessGroup | undefined {
  return owners.get(child)
}

/** The caller must spawn detached; this owner also cleans descendants after natural root exit. */
export function ownPosixProcessGroup(child: ChildProcess): OwnedPosixProcessGroup {
  const existing = owners.get(child)
  if (existing) {
    return existing
  }
  let terminated = false
  let reportTermination = (): void => {}
  const termination = new Promise<void>((resolve) => {
    reportTermination = resolve
  })
  let attempt: Promise<boolean> | undefined
  let reportAttempt: ((verified: boolean) => void) | undefined
  let escalation: ReturnType<typeof setTimeout> | undefined

  const reportTerminated = (): void => {
    if (terminated) {
      return
    }
    terminated = true
    clearTimeout(escalation)
    child.off('exit', onRootExit)
    child.off('close', onRootExit)
    child.off('error', onError)
    reportTermination()
    reportAttempt?.(true)
  }
  const reportIfGone = (): boolean => {
    if (!child.pid || !posixProcessGroupExists(child.pid)) {
      reportTerminated()
      return true
    }
    return false
  }
  const force = async (): Promise<void> => {
    const verified = await forceTerminateProcessTree(child).catch(() => false)
    if (verified) {
      reportTerminated()
    }
    reportAttempt?.(verified)
  }
  const stop = (signal?: NodeJS.Signals): Promise<boolean> => {
    if (terminated || reportIfGone()) {
      return Promise.resolve(true)
    }
    if (attempt) {
      return attempt
    }
    attempt = new Promise<boolean>((resolve) => {
      reportAttempt = resolve
    })
    if (signal === 'SIGKILL') {
      void force()
    } else {
      void signalProcessTree(child, signal).catch(() => false)
      escalation = setTimeout(() => void force(), PROCESS_GROUP_EXIT_GRACE_MS)
    }
    return attempt
  }
  function onRootExit(): void {
    if (!reportIfGone()) {
      void stop()
    }
  }
  function onError(): void {
    void stop()
  }
  const owner = { terminated: termination, stop }
  owners.set(child, owner)
  child.once('exit', onRootExit)
  child.once('close', onRootExit)
  child.on('error', onError)
  return owner
}
