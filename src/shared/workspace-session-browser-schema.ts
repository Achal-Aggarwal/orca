import {
  ScalarBoolean,
  ScalarNullableString,
  ScalarNumber,
  ScalarOptionalBoolean,
  ScalarOptionalNullableString,
  ScalarOptionalString,
  ScalarString
} from './scalar-value-schemas'
import { z } from 'zod'
import type { BrowserWorkspace } from './browser-workspace-types'
import { normalizeBrowserHistoryEntries } from './workspace-session-browser-history'
import { normalizeWorkspaceDocHistoryEntries } from './workspace-doc-history'
import { isDocPreviewUrl } from './doc-preview-scheme'
import { salvagingArray } from './zod-salvage'

const browserLoadErrorSchema = z.object({
  code: ScalarNumber,
  description: ScalarString,
  validatedUrl: ScalarString
})

/** Persist document identity only; restore re-reads its current owner and mints a fresh grant rather than saving grant URLs. */
const browserPageDocLocationSchema = z.object({
  kind: z.literal('workspace-doc'),
  worktreeId: ScalarString,
  filePath: ScalarString
})

const browserViewportPresetIdSchema = z.enum([
  'mobile-s',
  'mobile-m',
  'mobile-l',
  'tablet',
  'laptop',
  'laptop-l',
  'desktop'
])

// z.object strips unlisted fields regardless of the static BrowserWorkspace annotation; declare additive fields here for restore.
export const browserWorkspaceSchema: z.ZodType<BrowserWorkspace> = z.object({
  id: ScalarString,
  worktreeId: ScalarString,
  label: ScalarOptionalString,
  sessionProfileId: ScalarOptionalNullableString,
  // Preserve isolated storage across restarts even if the profile mirror is stale; tolerate pre-field sessions (#6923).
  sessionPartition: ScalarOptionalNullableString,
  activePageId: ScalarOptionalNullableString,
  pageIds: z.array(ScalarString).optional(),
  url: ScalarString,
  title: ScalarString,
  loading: ScalarBoolean,
  faviconUrl: ScalarNullableString,
  canGoBack: ScalarBoolean,
  canGoForward: ScalarBoolean,
  loadError: browserLoadErrorSchema.nullable(),
  createdAt: ScalarNumber,
  docLocation: browserPageDocLocationSchema.nullable().optional()
})

const browserPageConversionOriginSchema = z
  .union([
    z.object({ kind: z.literal('workspace-doc'), docLocation: browserPageDocLocationSchema }),
    z.object({
      kind: z.literal('url'),
      url: ScalarString,
      browserRuntimeEnvironmentId: ScalarOptionalNullableString
    })
  ])
  .nullable()
  .optional()
  .transform((origin) =>
    origin && origin.kind === 'url' && isDocPreviewUrl(origin.url) ? null : origin
  )

export const browserPageSchema = z.object({
  id: ScalarString,
  workspaceId: ScalarString,
  worktreeId: ScalarString,
  url: ScalarString,
  title: ScalarString,
  loading: ScalarBoolean,
  faviconUrl: ScalarNullableString,
  canGoBack: ScalarBoolean,
  canGoForward: ScalarBoolean,
  loadError: browserLoadErrorSchema.nullable(),
  createdAt: ScalarNumber,
  // Why: explicit null marks a browser page as client-local even when its
  // worktree is remote-owned; older sessions omit it and keep inferred runtime.
  browserRuntimeEnvironmentId: ScalarOptionalNullableString,
  // Both remote page identity fields must survive restore to reclaim a client-hosted page; older sessions may omit them.
  remoteBrowserPageId: ScalarOptionalNullableString,
  remoteBrowserPageClientHosted: ScalarOptionalBoolean,
  // Preserve the viewport preset across restart while accepting older sessions.
  viewportPresetId: browserViewportPresetIdSchema.nullable().optional(),
  // Without docLocation, a workspace document’s blank URL restores as New Tab.
  docLocation: browserPageDocLocationSchema.nullable().optional(),
  // Persist one-level conversion history; reject preview-scheme URLs at this read boundary as at every URL sink.
  convertedFrom: browserPageConversionOriginSchema,
  convertedTo: browserPageConversionOriginSchema
})

const browserHistoryEntrySchema = z.object({
  url: ScalarString,
  normalizedUrl: ScalarString,
  title: ScalarString,
  faviconUrl: ScalarOptionalNullableString,
  lastVisitedAt: ScalarNumber,
  visitCount: ScalarNumber
})

export const browserHistoryEntriesSchema = salvagingArray(browserHistoryEntrySchema).transform(
  (entries) => normalizeBrowserHistoryEntries(entries)
)

// A document identity and nothing else: no url field exists for a grant URL to land in.
const workspaceDocHistoryEntrySchema = z.object({
  docLocation: browserPageDocLocationSchema,
  title: ScalarString,
  lastVisitedAt: ScalarNumber,
  visitCount: ScalarNumber
})

export const workspaceDocHistoryEntriesSchema = salvagingArray(
  workspaceDocHistoryEntrySchema
).transform((entries) => normalizeWorkspaceDocHistoryEntries(entries))
