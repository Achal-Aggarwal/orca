import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  SkillDiscoveryTargetSchema,
  type SkillDiscoveryResult,
  type SkillDiscoveryTarget
} from '../../shared/skills'
import {
  BundledSkillExecuteRequestSchema,
  BundledSkillPlanRequestSchema,
  type BundledSkillInstallResult,
  type BundledSkillPlan
} from '../../shared/bundled-skill-plan'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../skills/skill-discovery-target'
import { unavailableWhileWslDistroStopped } from '../skills/skill-discovery-stopped-wsl-roots'
import { registerSkillCloudIpcHandlers } from './skill-cloud-ipc-handlers'
import { handleMainWindowSkillIpc } from './skill-ipc-main-window'

export function registerSkillsHandlers(store: Store, runtime?: OrcaRuntimeService): void {
  const discover = async (target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => {
    const parsedTarget = target ? SkillDiscoveryTargetSchema.parse(target) : undefined
    return unavailableWhileWslDistroStopped(async () => {
      const resolvedTarget = await resolveSkillDiscoveryTarget(parsedTarget, {
        refuseStoppedWslDistro: true
      })
      return discoverSkillsOnTarget(resolvedTarget, store.getRepos(), {
        providerRootOverrides: await runtime?.resolveSkillDiscoveryProviderRoots(resolvedTarget),
        refresh: parsedTarget?.refresh === true
      })
    })
  }

  handleMainWindowSkillIpc(
    'skills:discover',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => discover(target)
  )

  if (!runtime) {
    return
  }
  registerSkillCloudIpcHandlers(runtime, discover)

  // Local host only; paired hosts plan Orca's skills over RPC.
  handleMainWindowSkillIpc(
    'skills:bundledPlan',
    async (_event, value: unknown): Promise<BundledSkillPlan> =>
      runtime.planLocalBundledSkills(BundledSkillPlanRequestSchema.parse(value ?? {}))
  )
  handleMainWindowSkillIpc(
    'skills:bundledExecute',
    async (_event, value: unknown): Promise<BundledSkillInstallResult> =>
      runtime.executeLocalBundledSkills(BundledSkillExecuteRequestSchema.parse(value))
  )
}
