import {
  chooseSavedResumeFreshLaunch,
  type ResumeSpawnAdmission,
  resumeSpawnRefusal
} from '../host-env/saved-resume-admission'
import type { RuntimePtySpawnState } from './spawn-state'

export async function chooseRuntimeSavedResumeFreshLaunch(
  ctx: RuntimePtySpawnState,
  captured: ResumeSpawnAdmission | null
): Promise<void> {
  const args = ctx.args
  ctx.spawnOptions.env = { ...ctx.spawnOptions.env }
  ctx.resumeAdmission = await chooseSavedResumeFreshLaunch(
    ctx.deps.runtime,
    args,
    ctx.expectedWslDistro,
    ctx.spawnOptions
  )
  if (captured && ctx.resumeAdmission) {
    ctx.resumeAdmission.refused = captured.refused
    ctx.resumeAdmission.sourceRecord = captured.sourceRecord
  }
  if (resumeSpawnRefusal(ctx.resumeAdmission)) {
    ctx.launchCommand = undefined
    ctx.env = ctx.spawnOptions.env
  }
}
