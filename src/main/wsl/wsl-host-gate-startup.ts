import { readWslHostDeployments } from '../../shared/wsl-host-deployment-store'
import { WSL_MOVE_CUTOVER_PHASES } from '../../shared/wsl-move/wsl-move-cutover'
import { listWslMoveCutovers } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import { configureWslHostsGate } from './wsl-host-gate'

const COMMITTED_PHASE_INDEX = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')

/** Reads only with the internal gate closed: an open gate needs no promotion. */
export function configureWslHostsGateFromDisk(userDataPath: string): void {
  configureWslHostsGate({
    hasSavedWslHost: () => readWslHostDeployments(userDataPath).deployments.length > 0,
    hasCommittedWslMove: () =>
      listWslMoveCutovers(userDataPath).some(
        (cutover) => WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) >= COMMITTED_PHASE_INDEX
      )
  })
}
