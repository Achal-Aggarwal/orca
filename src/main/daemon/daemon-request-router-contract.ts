import type { DaemonClientConnections } from './daemon-client-connections'
import type { DaemonFileLog } from './daemon-file-log'
import type { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import type { DaemonServerLifecycle } from './daemon-server-lifecycle'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import type { DaemonSessionBackgroundRouting } from './daemon-session-background-routing'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { DaemonTerminalAdmission } from './daemon-terminal-admission'
import type { TerminalHistorySeedTransferRegistry } from './terminal-history-seed-transfer-registry'
import type { TerminalHost } from './terminal-host'

export type DaemonRequestRouterOptions = {
  host: TerminalHost
  connections: DaemonClientConnections
  lifecycle: DaemonServerLifecycle
  admission: DaemonTerminalAdmission
  preparations: DaemonPtySpawnPreparations
  attachments: DaemonSessionAttachments
  historySeedTransfers: TerminalHistorySeedTransferRegistry
  sessionBackgroundRouting: DaemonSessionBackgroundRouting
  streamDataBatcher: DaemonStreamDataBatcher
  ptySpawnHealthCheck: () => Promise<void>
  log: DaemonFileLog
}
