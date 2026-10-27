import type { LocalProjectGhExecOptions } from '../project-runtime-git-options'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'

export function hostedReviewExecutionOptions(
  options: LocalProjectGhExecOptions | undefined,
  admissionTier?: GitAdmissionTier
):
  | { localGitExecOptions: LocalProjectGhExecOptions & { admissionTier?: GitAdmissionTier } }
  | undefined {
  const localGitOptions = {
    ...options,
    ...(admissionTier && { admissionTier })
  }
  return Object.keys(localGitOptions).length > 0
    ? { localGitExecOptions: localGitOptions }
    : undefined
}
