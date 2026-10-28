import {
  ScalarNullableString,
  ScalarOptionalBoolean,
  ScalarOptionalString,
  ScalarString
} from '../scalar-value-schemas'
import { z } from 'zod'

/** Host-owned sidebar facts use ExecutionHostId spellings and each row’s own workspace ID. */
export const DesktopSidebarFactsSchema = z.object({
  /** What the desktop window last saved as open; both null when nothing is. */
  desktopActive: z.object({
    hostId: ScalarNullableString,
    worktreeId: ScalarNullableString
  }),
  /** Pins in this host's metadata, git and folder; may name a workspace no longer listed, so read against rows. */
  pinnedWorkspaceIds: z.array(ScalarString),
  /** This host's projects in the desktop's manual order. */
  repoOrder: z.array(z.object({ hostId: ScalarString, repoId: ScalarString })),
  /** The saved host-section order; hosts it omits follow in discovery order. */
  workspaceHostOrder: z.array(ScalarString),
  // Statuses stay open strings so a status a newer host adds never fails an older reader's parse.
  /** Configured SSH targets by host id; status is null until a connection is attempted. */
  sshHosts: z.record(ScalarString, z.object({ label: ScalarString, status: ScalarNullableString })),
  /** WSL hosts by host id, where this host can run them. */
  wslHosts: z.record(ScalarString, z.object({ distro: ScalarString, state: ScalarString })),
  /** The host the desktop has focused, where its sidebar files rows that name no owner. */
  focusedHostId: ScalarOptionalString,
  /** The user's own names for hosts, by host id. */
  hostLabels: z.record(ScalarString, ScalarString).optional(),
  /** "Also show pinned workspaces in their groups"; absent reads as off. */
  showPinnedInGroups: ScalarOptionalBoolean
})

export type DesktopSidebarFacts = z.infer<typeof DesktopSidebarFactsSchema>
