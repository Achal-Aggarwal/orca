import { ScalarNonemptyString, ScalarString } from './scalar-value-schemas'
import { z } from 'zod'
import { AI_VAULT_AGENTS } from './ai-vault-types'

export const AiVaultChatForkSourceSchema = z.object({
  agent: z.enum(AI_VAULT_AGENTS),
  sourceAgent: z.enum(AI_VAULT_AGENTS),
  sessionId: ScalarNonemptyString,
  filePath: ScalarString,
  cwd: ScalarNonemptyString.nullable(),
  codexHome: ScalarNonemptyString.nullable(),
  executionHostPlatform: z.enum([
    'aix',
    'android',
    'darwin',
    'freebsd',
    'haiku',
    'linux',
    'openbsd',
    'sunos',
    'win32',
    'cygwin',
    'netbsd'
  ])
})
