export type * as pty from 'node-pty'
export { ptyShellProcessId } from '../../windows/windows-pty-job'
export * as foreground from '../../providers/pty-foreground-confirmation'
export { getAgentForegroundContextPaths } from '../../providers/agent-foreground-context-paths'
export { confirmPtyShellForeground } from './pty-shell-foreground-confirmation'
export {
  judgeCachedAgentJobEvidence,
  WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS
} from '../../providers/windows-cached-agent-revalidation'
export {
  isWindowsPtyJobReadable,
  readWindowsPtyJobProcessIds
} from '../../providers/windows-pty-job-membership'

export {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess,
  type RecognizedAgentProcess
} from '../../../shared/agent-process-recognition'
export {
  shouldInspectOuterWrapperForegroundName,
  shouldInspectOuterWrapperForegroundProcess
} from '../../../shared/foreground-wrapper-agent'
export { isShellProcess } from '../../../shared/shell-process-detection'
export {
  resolveFallbackForegroundProcess,
  shouldInspectFallback
} from './foreground-fallback-process'
export { parsePtySessionId } from '../../../shared/pty-session-id-format'
export {
  ptyProcessNameIsSpawnFile,
  createPtyForegroundResolver,
  shouldCachePtyForeground
} from './spawn-file-foreground-process'

export * from './foreground-process-tracker-contract'
