import { RpcNumber, RpcOptionalBoolean, RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import {
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_REMOTE_RUNTIMES
} from '../ssh-types'
import { OptionalString, requiredString } from './rpc-param-primitives'

export const SshTarget = z.object({
  targetId: RpcString.min(1)
})

// Why `automatic`: a client's background connect must not lift the host's cancelled sign-in.
export const SshConnect = SshTarget.extend({
  automatic: RpcOptionalBoolean
})

const boundedText = (max: number) => RpcString.trim().min(1).max(max)

// Reject unknown keys, including credentials and host-owned fences, so callers cannot believe secrets were saved.
// Ask for credentials when connecting.
export const SshEditableTargetInput = z
  .object({
    label: boundedText(200),
    configHost: boundedText(512).optional(),
    host: boundedText(512),
    port: RpcNumber.int().min(1).max(65_535),
    username: RpcString.trim().max(200),
    identityFile: boundedText(4096).optional(),
    identityAgent: boundedText(4096).optional(),
    identitiesOnly: RpcOptionalBoolean,
    gssapiAuthentication: RpcOptionalBoolean,
    proxyCommand: boundedText(4096).optional(),
    jumpHost: boundedText(1024).optional(),
    relayGracePeriodSeconds: RpcNumber.int()
      .min(0)
      .max(MAX_SSH_RELAY_GRACE_PERIOD_SECONDS)
      .refine(
        (value) => value === 0 || value >= MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
        `Terminal timeout must be 0 or at least ${MIN_SSH_RELAY_GRACE_PERIOD_SECONDS} seconds`
      )
      .optional(),
    systemSshConnectionReuse: RpcOptionalBoolean,
    systemSshProxyConnectionReuse: RpcOptionalBoolean,
    remoteRuntime: z.enum(SSH_REMOTE_RUNTIMES).optional(),
    allowRemoteCliControl: RpcOptionalBoolean
  })
  .strict()

export const SshTargetAdd = z.object({ target: SshEditableTargetInput })

/** Replaces the target's editable fields; an omitted optional field is cleared. */
export const SshTargetUpdate = SshTarget.extend({ target: SshEditableTargetInput })

// Why untrimmed: a remote folder name may legitimately end in a space.
export const SshBrowseDir = SshTarget.extend({
  dirPath: RpcString.min(1).max(4096)
})

export const RepoAddRemote = z.object({
  connectionId: requiredString('Missing SSH target'),
  remotePath: requiredString('Missing remote path'),
  displayName: OptionalString,
  kind: z.enum(['git', 'folder']).optional()
})
