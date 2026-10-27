import * as dependencies from './foreground-process-tracker-dependencies'

export function createPtyForegroundProcessTracker(
  args: dependencies.PtyForegroundProcessTrackerOptions
): dependencies.PtyForegroundProcessTracker {
  const proc = args.process
  const staticName = dependencies.ptyProcessNameIsSpawnFile(proc)
  const resolveForeground = dependencies.createPtyForegroundResolver(proc)
  let lastPresentation: dependencies.ForegroundPresentationCache | null = null
  let lastOutputAt = 0
  // `pid` anchors the identity to the row that proved it (null when ambiguous).
  let cachedAgentForeground: dependencies.CachedAgentForeground | null = null
  const contextPaths = dependencies.getAgentForegroundContextPaths({
    cwd: args.cwd,
    worktreeId: dependencies.parsePtySessionId(args.sessionId).worktreeId
  })
  let startupAgentForeground: dependencies.StartupAgentForeground | null =
    args.startupAgentRecognition
      ? {
          processName: args.startupAgentRecognition.processName,
          expiresAt: Date.now() + dependencies.STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS
        }
      : null
  let foregroundRefreshInFlight = false
  let lastForegroundRefreshStartedAt = 0
  const cacheAgentForeground = (processName: string, pid: number | null): void => {
    cachedAgentForeground = { processName, pid, refreshedAt: Date.now() }
    startupAgentForeground = null
  }
  const getFallbackProcess = (): string | null =>
    dependencies.resolveFallbackForegroundProcess(
      staticName ? args.shellPath : proc.process,
      args.shellPath
    )
  const getActiveStartupAgent = (now = Date.now()): dependencies.StartupAgentForeground | null => {
    if (startupAgentForeground && now > startupAgentForeground.expiresAt) {
      startupAgentForeground = null
    }
    return startupAgentForeground
  }
  const scheduleRefresh = (fallbackProcess: string | null): void => {
    if (args.isDead() || !proc.pid) {
      return
    }
    const fallbackIsShell = fallbackProcess !== null && dependencies.isShellProcess(fallbackProcess)
    const fallbackRecognition = dependencies.recognizeAgentProcess(fallbackProcess)
    if (
      !fallbackProcess ||
      (fallbackRecognition !== null &&
        !dependencies.shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
      !dependencies.shouldInspectFallback(fallbackProcess)
    ) {
      return
    }
    const now = Date.now()
    const idleNoEvidenceShell =
      fallbackIsShell && !getActiveStartupAgent(now) && !cachedAgentForeground
    const retryMs = !idleNoEvidenceShell
      ? dependencies.FOREGROUND_AGENT_CACHE_TTL_MS
      : process.platform === 'win32' &&
          now - lastOutputAt > dependencies.SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS
        ? dependencies.WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS
        : dependencies.SHELL_FOREGROUND_REFRESH_RETRY_MS
    if (foregroundRefreshInFlight || now - lastForegroundRefreshStartedAt < retryMs) {
      return
    }
    foregroundRefreshInFlight = true
    lastForegroundRefreshStartedAt = now
    const identityOlderThan = (ms: number): boolean =>
      cachedAgentForeground !== null && Date.now() - cachedAgentForeground.refreshedAt > ms
    const retireStaleForegroundIdentity = ({ onlyWhenAged = false } = {}): void => {
      const currentFallbackProcess = getFallbackProcess()
      if (
        fallbackIsShell &&
        !getActiveStartupAgent() &&
        currentFallbackProcess !== null &&
        dependencies.isShellProcess(currentFallbackProcess) &&
        (!onlyWhenAged ||
          identityOlderThan(dependencies.WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS))
      ) {
        cachedAgentForeground = null
        startupAgentForeground = null
      } else if (
        identityOlderThan(dependencies.FOREGROUND_AGENT_CACHE_TTL_MS) &&
        currentFallbackProcess !== null &&
        dependencies.isAgentForegroundWrapperProcess(currentFallbackProcess)
      ) {
        cachedAgentForeground = null
      }
    }
    const anchor = cachedAgentForeground
    void resolveForeground(proc.pid, fallbackProcess, {
      contextPaths,
      ...(anchor?.pid != null
        ? { anchorProcessId: anchor.pid, anchorProcessName: anchor.processName }
        : {})
    })
      .then<string | void>((result) => {
        const { processName, processId, available, anchorPidForeign, shellForeground } = result
        if (args.isDead() || !available) {
          return
        }
        lastPresentation =
          dependencies.recognizeAgentProcess(processName) || shellForeground
            ? {
                state: shellForeground ? 'not-in-front' : 'agent-in-front',
                fallback: fallbackProcess,
                at: Date.now()
              }
            : null
        if (!dependencies.shouldCachePtyForeground(processName, staticName)) {
          if (process.platform === 'win32' && fallbackIsShell && cachedAgentForeground !== null) {
            // Job membership avoids attaching to the console or forking a helper.
            const verdict = dependencies.judgeCachedAgentJobEvidence({
              jobProcessIds: dependencies.readWindowsPtyJobProcessIds(proc),
              jobSupported: dependencies.isWindowsPtyJobReadable(),
              shellPid: dependencies.ptyShellProcessId(proc) ?? proc.pid,
              anchorProcessId: cachedAgentForeground.pid,
              identityAgeMs: Date.now() - cachedAgentForeground.refreshedAt
            })
            // Unavailable evidence cannot prove exit.
            if (verdict === 'unavailable') {
              return
            }
            if (verdict === 'unsupported') {
              // Without job support, use the available scan that found no agent.
              retireStaleForegroundIdentity()
              return
            }
            if (verdict === 'confirmed' || verdict === 'recheck') {
              if (anchorPidForeign === true) {
                retireStaleForegroundIdentity()
                return
              }
              // Keep an anchored identity while its PID remains in the job and no foreign identity was found.
              cachedAgentForeground = { ...cachedAgentForeground, refreshedAt: Date.now() }
              return
            }
            if (verdict === 'exited' || verdict === 'anchor-exited') {
              // Retire only after an available scan found no agent.
              retireStaleForegroundIdentity()
              return
            }
            // Unanchored job members may be detached leftovers; bound the cached identity’s age.
            retireStaleForegroundIdentity({ onlyWhenAged: true })
            return
          }
          retireStaleForegroundIdentity()
          return
        }
        cachedAgentForeground = { processName, pid: processId ?? null, refreshedAt: Date.now() }
        startupAgentForeground = null
        return processName
      })
      .catch(() => {
        // Best-effort only: foreground enrichment must never affect PTY health.
      })
      .finally(() => {
        foregroundRefreshInFlight = false
      })
  }

  return {
    recordOutput: (data) => {
      if (data.length > 0) {
        lastOutputAt = Date.now()
      }
    },
    markDead: () => {
      lastPresentation = null
      cachedAgentForeground = null
      startupAgentForeground = null
    },
    getForegroundProcess: (options) => {
      options?.acceptPresentation?.(undefined)
      if (args.isDead()) {
        return null
      }
      if (options?.cachedOnly === true) {
        return cachedAgentForeground &&
          Date.now() - cachedAgentForeground.refreshedAt <=
            dependencies.FOREGROUND_AGENT_CACHE_TTL_MS
          ? cachedAgentForeground.processName
          : null
      }
      if (options?.rawFallback === true) {
        return getFallbackProcess()
      }
      try {
        const fallbackProcess = getFallbackProcess()
        if (
          lastPresentation &&
          lastPresentation.fallback === fallbackProcess &&
          !(
            process.platform === 'win32' &&
            lastPresentation.state === 'not-in-front' &&
            cachedAgentForeground
          ) &&
          Date.now() - lastPresentation.at <= dependencies.FOREGROUND_AGENT_CACHE_TTL_MS
        ) {
          options?.acceptPresentation?.(lastPresentation.state)
        }
        const fallbackRecognition = dependencies.recognizeAgentProcess(fallbackProcess)
        const inspectOuterWrapper =
          fallbackRecognition !== null &&
          dependencies.shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)
        if (fallbackProcess && fallbackRecognition && !inspectOuterWrapper) {
          options?.acceptPresentation?.('agent-in-front')
          cacheAgentForeground(fallbackProcess, null)
          return fallbackProcess
        }
        scheduleRefresh(fallbackProcess)
        const now = Date.now()
        if (
          cachedAgentForeground &&
          now - cachedAgentForeground.refreshedAt <= dependencies.FOREGROUND_AGENT_CACHE_TTL_MS
        ) {
          return cachedAgentForeground.processName
        }
        if (
          cachedAgentForeground &&
          fallbackProcess !== null &&
          (staticName ||
            dependencies.isAgentForegroundWrapperProcess(fallbackProcess) ||
            inspectOuterWrapper ||
            (process.platform === 'win32' && dependencies.isShellProcess(fallbackProcess)))
        ) {
          return cachedAgentForeground.processName
        }
        const activeStartupAgentForeground = getActiveStartupAgent(now)
        if (
          fallbackProcess &&
          dependencies.isShellProcess(fallbackProcess) &&
          activeStartupAgentForeground
        ) {
          return activeStartupAgentForeground.processName
        }
        return fallbackProcess
      } catch {
        return null
      }
    },
    confirmForegroundProcess: async (context) => {
      context?.acceptPresentation?.(undefined)
      if (args.isDead() || !proc.pid) {
        return null
      }
      const decision = process.platform === 'win32' && context?.decision === true
      const anchor = cachedAgentForeground
      try {
        const fallbackProcess = getFallbackProcess()
        if (!dependencies.foreground.shouldConfirmPtyForeground(fallbackProcess, decision)) {
          if (dependencies.recognizeAgentProcess(fallbackProcess)) {
            context?.acceptPresentation?.('agent-in-front')
          }
          return fallbackProcess
        }
        const { resolution, processName: name } =
          await dependencies.foreground.confirmFreshPtyForeground({
            process: proc,
            fallbackProcess,
            contextPaths,
            decision,
            anchor,
            anchorAt: anchor?.refreshedAt
          })
        if (args.isDead()) {
          return null
        }
        if (!resolution.available && !decision) {
          return null
        }
        if (resolution.available && name === resolution.processName) {
          if (dependencies.recognizeAgentProcess(resolution.processName)) {
            context?.acceptPresentation?.('agent-in-front')
          } else if (resolution.shellForeground) {
            context?.acceptPresentation?.('not-in-front')
          }
        }
        const recognized = dependencies.recognizeAgentProcess(resolution.processName)
        const processName = decision ? name : (recognized?.processName ?? resolution.processName)
        const cacheName = decision ? (recognized?.processName ?? null) : processName
        if (
          resolution.available &&
          dependencies.shouldCachePtyForeground(cacheName, decision ? false : staticName)
        ) {
          cacheAgentForeground(cacheName, resolution.processId ?? null)
        } else if (!decision || processName !== anchor?.processName) {
          cachedAgentForeground = null
          startupAgentForeground = null
        }
        return processName
      } catch {
        return null
      }
    },
    confirmShellForeground: () =>
      dependencies.confirmPtyShellForeground({
        process: proc,
        shellPath: args.shellPath,
        isDead: args.isDead
      })
  }
}

export type { PtyForegroundProcessTracker } from './foreground-process-tracker-contract'
