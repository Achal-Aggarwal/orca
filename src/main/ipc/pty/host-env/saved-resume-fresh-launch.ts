import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import {
  admitResumeSpawn,
  applySavedResumeLaunch,
  type AdmissionRuntime,
  type ResumeSpawnArgs,
  type ResumeSpawnAdmission,
  type ResumeSpawnRefusal
} from './saved-resume-admission'

/** Unwinds only the claim whose fresh callback has issued no physical work. */
export class SavedResumeFreshRefusal extends Error {
  readonly recovered: Promise<PtySpawnResult>
  resolve!: (result: PtySpawnResult) => void
  reject!: (error: unknown) => void
  constructor(readonly admission: ResumeSpawnRefusal) {
    super('saved_resume_fresh_refused')
    this.recovered = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    void this.recovered.catch(() => {})
  }
}

/** Runs only in the fresh branch, after stable/claimed owner adoption has settled. */
export async function chooseSavedResumeFreshLaunch(
  runtime: AdmissionRuntime | undefined,
  args: ResumeSpawnArgs,
  wslDistro: string | null,
  options: ResumeSpawnArgs & { startupCommandDelivery?: unknown; startupIngress?: unknown },
  assembledEnvironment = false
): Promise<ResumeSpawnAdmission | null> {
  const admission = await admitResumeSpawn(
    runtime,
    {
      ...args,
      assembledEnvironment,
      cwd: options.cwd,
      command: options.command,
      shellOverride: options.shellOverride,
      env: options.env,
      envToDelete: options.envToDelete
    },
    wslDistro
  )
  applySavedResumeLaunch(admission, args, options)
  return admission
}
