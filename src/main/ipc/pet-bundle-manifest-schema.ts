import {
  ScalarNonemptyString,
  ScalarNumber,
  ScalarPositiveInteger,
  ScalarString
} from '../../shared/scalar-value-schemas'
import { z } from 'zod'
import type { PetManifestLike } from './pet-bundle'

export const PetManifestSchema = z
  .object({
    id: ScalarNonemptyString.max(128).optional(),
    displayName: ScalarNonemptyString.max(120).optional(),
    description: ScalarString.max(2000).optional(),
    spritesheetPath: ScalarNonemptyString.max(255)
      // Reject unsafe manifest paths before the later resolved-path containment check.
      .refine(
        (p) => !p.includes('\0') && !p.startsWith('/') && !p.startsWith('\\') && !p.includes('..'),
        'invalid spritesheetPath'
      )
      .optional(),
    frame: z
      .object({
        width: ScalarPositiveInteger.max(1024),
        height: ScalarPositiveInteger.max(1024)
      })
      .optional(),
    fps: ScalarNumber.positive().max(60).optional(),
    defaultAnimation: ScalarNonemptyString.max(64).optional(),
    animations: z
      .record(
        ScalarNonemptyString.max(64),
        z.object({
          row: ScalarNumber.int().min(0).max(256),
          frames: ScalarPositiveInteger.max(512),
          // Bound frame holds so malformed manifests cannot freeze the overlay.
          frameDurationsMs: z.array(ScalarNumber.positive().max(60_000)).max(512).optional()
        })
      )
      .optional()
  })
  // Accept generator metadata beyond the fields Orca consumes.
  .loose()

export type PetManifest = z.infer<typeof PetManifestSchema> & PetManifestLike
