import { RpcString, RpcUnknown } from './rpc-value-schemas'
import { z } from 'zod'
import {
  MAX_ORCAD_MIGRATION_BLOBS,
  OrcadMigrationBlobDescriptorSchema
} from '../orcad-migration/orcad-migration-blob-transfer'

// Let the handler parse/digest-check the manifest so malformed input receives a migration-specific refusal.
export const OrcadMigrationCatalogParams = z.object({ manifest: RpcUnknown })

// Optional: sent only to a blob-channel destination, so SSH and older peers see `{ manifest }`.
export const OrcadMigrationCommitCatalogParams = OrcadMigrationCatalogParams.extend({
  expectedBlobs: z
    .array(OrcadMigrationBlobDescriptorSchema)
    .max(MAX_ORCAD_MIGRATION_BLOBS)
    .optional()
})

// The manifest's identity alone, for a request the whole manifest would overflow.
export const OrcadMigrationCatalogReferenceParams = z.object({
  migrationId: RpcString.min(1).max(256),
  manifestSha256: RpcString.regex(/^[a-f0-9]{64}$/)
})
