import { useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import { useAppStore } from '@/store'
import { getRepoSshConnection, selectRepoSshGateInput } from '@/lib/repo-ssh-connection'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../shared/repo-types'

type Gate = ReturnType<typeof selectRepoSshGateInput>
export type RepoSshGateResolver = (repo: Repo) => Gate
const NO_GATE: Gate = { connectionId: null, status: null }

function connectionKey(repo: Repo): string {
  const connection = getRepoSshConnection(repo)
  return JSON.stringify(connection && [connection.environmentId, connection.targetId])
}

function createRepoSshGateSelector(repos: ReadonlyMap<string, Repo>) {
  const targets = new Map([...repos.values()].map((repo) => [connectionKey(repo), repo]))
  let inputs: readonly unknown[] = []
  let gates = new Map<string, Gate>()
  let resolve: RepoSshGateResolver = () => NO_GATE
  return (state: AppState): RepoSshGateResolver => {
    const nextInputs = [
      state.sshConnectionStates,
      state.sshStateByEnvironment,
      state.runtimeStatusByEnvironmentId
    ]
    if (shallow(inputs, nextInputs)) {
      return resolve
    }
    inputs = nextInputs
    const next = new Map<string, Gate>()
    for (const [key, repo] of targets) {
      const gate = selectRepoSshGateInput(state, repo)
      const previous = gates.get(key)
      next.set(key, previous && shallow(previous, gate) ? previous : gate)
    }
    if (!shallow(gates, next)) {
      gates = next
      resolve = (repo) => next.get(connectionKey(repo)) ?? NO_GATE
    }
    return resolve
  }
}

/** Observe only the SSH gates used by this viewport's repositories. */
export function useRepoSshGateResolver(repos: ReadonlyMap<string, Repo>): RepoSshGateResolver {
  const select = useMemo(() => createRepoSshGateSelector(repos), [repos])
  return useAppStore(select)
}
