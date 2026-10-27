import type { ResumeSpawnAdmission } from './saved-resume-admission'

export function savedResumeResult(admission: ResumeSpawnAdmission | null) {
  if (!admission) {
    return {}
  }
  const { agent, providerSession } = admission.refused
  return {
    savedResumeDecision: { agent, providerSession, verdict: admission.verdict },
    ...(admission.verdict !== 'admitted'
      ? {
          agentResumeRefused: admission.verdict,
          agentResumeUnavailable: true as const,
          refusedResume: admission.refused
        }
      : {})
  }
}
