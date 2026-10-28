import {
  ScalarBoolean,
  ScalarOptionalBoolean,
  ScalarString
} from '../../shared/scalar-value-schemas'
import { z } from 'zod'

const sandboxPolicy = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('readOnly'), networkAccess: ScalarOptionalBoolean }),
  z.looseObject({ type: z.literal('dangerFullAccess') }),
  z.looseObject({
    type: z.literal('workspaceWrite'),
    writableRoots: z.array(ScalarString),
    networkAccess: ScalarBoolean,
    excludeTmpdirEnvVar: ScalarBoolean,
    excludeSlashTmp: ScalarBoolean
  }),
  z.looseObject({
    type: z.literal('externalSandbox'),
    networkAccess: z.enum(['enabled', 'restricted'])
  })
])

export type CodexSandboxPolicy = z.infer<typeof sandboxPolicy>

/** Replay the provider's complete policy, including fields a newer binary may add. */
export function readCodexSandboxPolicy(value: unknown): CodexSandboxPolicy | undefined {
  const parsed = sandboxPolicy.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
